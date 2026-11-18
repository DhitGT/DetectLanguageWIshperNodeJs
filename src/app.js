import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import { timingSafeEqual, createHash } from 'node:crypto';
import { decodeAudio } from './audio.js';
import { ServiceError } from './errors.js';

export async function createApp(config, detector, decode = decodeAudio) {
    const app = Fastify({
        logger: { redact: ['req.headers.authorization'] },
        bodyLimit: config.maxUploadBytes + 65536, requestTimeout: 30000,
        connectionTimeout: 35000, keepAliveTimeout: 5000, trustProxy: false,
    });
    await app.register(multipart, { throwFileSizeLimit: false, limits: {
        fileSize: config.maxUploadBytes, files: 1, fields: 0, parts: 1, headerPairs: 100,
    } });
    if (config.origins.length) await app.register(cors, { origin: config.origins, methods: ['POST'], allowedHeaders: ['Authorization', 'Content-Type'] });

    const expected = createHash('sha256').update(`Bearer ${config.apiKey}`).digest();
    let active = 0;
    const release = (request) => {
        if (request.detectionSlot) {
            request.detectionSlot = false;
            active--;
        }
    };
    app.decorateRequest('detectionSlot', false);
    app.addHook('onResponse', async (request) => release(request));
    app.addHook('onRequestAbort', async (request) => release(request));
    app.setErrorHandler((error, request, reply) => {
        const status = error.statusCode >= 400 && error.statusCode <= 599 ? error.statusCode : 500;
        // No exception bodies, audio, or authorization headers in error logs.
        if (status >= 500) request.log.error({ code: error.code || 'internal_error' }, 'Request gagal');
        reply.code(status).send({ error: {
            code: error.code || 'invalid_request',
            message: status >= 500 && !(error instanceof ServiceError) ? 'Pemrosesan gagal.' : error.message,
        } });
    });

    app.get('/healthz', async () => ({ status: 'ok' }));
    app.get('/readyz', async (request, reply) => detector.ready ? { status: 'ready', model: config.model } : reply.code(503).send({ status: 'not_ready' }));
    app.post('/v1/detect-language', {
        onRequest: async (request, reply) => {
            const provided = createHash('sha256').update(request.headers.authorization || '').digest();
            if (!timingSafeEqual(expected, provided)) return reply.code(401).header('WWW-Authenticate', 'Bearer').send({ error: { code: 'unauthorized', message: 'API key tidak valid.' } });
            const length = Number(request.headers['content-length'] || 0);
            if (!Number.isFinite(length) || length < 0) throw new ServiceError('invalid_length', 'Content-Length tidak valid.', 400);
            if (length > config.maxUploadBytes + 65536) throw new ServiceError('upload_too_large', 'Upload terlalu besar.', 413);
            if (!detector.ready) throw new ServiceError('not_ready', 'Model belum siap.', 503);
            if (active >= config.maxInFlight) return reply.code(429).header('Retry-After', '2').send({ error: { code: 'busy', message: 'Service sedang sibuk. Coba lagi.' } });
            active++;
            request.detectionSlot = true;
        },
    }, async (request) => {
        let buffer;
        for await (const part of request.parts()) {
            if (part.type !== 'file' || part.fieldname !== 'file') {
                if (part.file) part.file.resume();
                throw new ServiceError('missing_file', 'Kirim satu audio pada field multipart bernama file.');
            }
            buffer = await part.toBuffer();
            if (part.file.truncated) throw new ServiceError('upload_too_large', 'Ukuran audio melewati batas upload.', 413);
        }
        if (!buffer?.length) throw new ServiceError('empty_audio', 'Berkas audio kosong atau tidak dikirim.');
        const audio = await decode(buffer, config);
        return detector.detect(audio);
    });
    return app;
}
