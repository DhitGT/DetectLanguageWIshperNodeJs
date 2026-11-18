import test from 'node:test';
import assert from 'node:assert/strict';
import { readConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { decodeAudio } from '../src/audio.js';
import { ServiceError } from '../src/errors.js';
import { languageProbabilities, formatResult } from '../src/language.js';
import { speechRegions } from '../src/vad.js';

const KEY = 'test-secret-key-at-least-32-characters';
const authorization = `Bearer ${KEY}`;
const config = readConfig({ API_KEY: KEY, MAX_UPLOAD_MB: '1' });

function multipart(data = Buffer.from('audio'), field = 'file', extras = '') {
    const boundary = 'compac-test-boundary';
    return {
        headers: { authorization, 'content-type': `multipart/form-data; boundary=${boundary}` },
        payload: Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="sample.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
            data, Buffer.from(`\r\n${extras}--${boundary}--\r\n`),
        ]),
    };
}

function wav(seconds = 2, channels = 1, rate = 16000) {
    const size = Math.round(seconds * rate) * channels * 2;
    const buffer = Buffer.alloc(44 + size);
    buffer.write('RIFF', 0); buffer.writeUInt32LE(36 + size, 4); buffer.write('WAVEfmt ', 8);
    buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(rate, 24); buffer.writeUInt32LE(rate * channels * 2, 28);
    buffer.writeUInt16LE(channels * 2, 32); buffer.writeUInt16LE(16, 34);
    buffer.write('data', 36); buffer.writeUInt32LE(size, 40);
    return buffer;
}

async function makeApp(t, detector = { ready: true, detect: async () => ({ language: 'en', confidence: 0.95 }) }, overrides = {}) {
    const app = await createApp({ ...config, ...overrides }, detector, async () => new Float32Array(16000));
    app.log.level = 'silent';
    t.after(() => app.close());
    return app;
}

test('configuration rejects missing/placeholder keys, English-only models, and wildcard CORS', () => {
    for (const env of [{}, { API_KEY: 'short' }, { API_KEY: 'CHANGE_ME_abcdefghijklmnopqrstuvwxyz' }, { API_KEY: KEY, WHISPER_MODEL: 'base.en' }, { API_KEY: KEY, CORS_ORIGINS: '*' }, { API_KEY: KEY, MAX_IN_FLIGHT: '1.5' }]) {
        assert.throws(() => readConfig(env));
    }
    assert.equal(config.model, 'onnx-community/whisper-base');
});

test('language detection masks text tokens and computes stable probabilities', () => {
    const ranked = languageProbabilities([99999, 1000, 999, 998], { '<|en|>': 1, '<|id|>': 2, '<|ja|>': 3 });
    assert.equal(ranked[0].language, 'en');
    assert.ok(Math.abs(ranked.reduce((sum, item) => sum + item.confidence, 0) - 1) < 1e-10);
    assert.ok(ranked[0].confidence < 0.7);
    assert.throws(() => languageProbabilities([0], {}));
});

test('uncertain response never forces a language; locale is optional', () => {
    const uncertain = formatResult([{ language: 'en', confidence: 0.4 }], 0.7, 2, 1, 100);
    assert.equal(uncertain.status, 'uncertain');
    assert.equal(uncertain.language, null);
    assert.equal(uncertain.suggested_locale, null);
    assert.equal(formatResult([{ language: 'id', confidence: 0.9 }], 0.7, 2, 1, 100).suggested_locale, 'id-ID');
    assert.equal(formatResult([{ language: 'fr', confidence: 0.9 }], 0.7, 2, 1, 100).suggested_locale, null);
});

test('VAD regions discard clicks, merge padding, and count voiced samples', () => {
    assert.deepEqual(speechRegions([0, 0.9, 0, 0], 2048).regions, []);
    const result = speechRegions([0.9, 0.9, 0.9, 0, 0.9, 0.9, 0.9], 7 * 512);
    assert.equal(result.regions.length, 1);
    assert.equal(result.voicedSamples, 6 * 512);
    assert.equal(result.regions[0].end, 7 * 512);
});

test('health and readiness; authentication runs before multipart parsing', async (t) => {
    let calls = 0;
    const app = await makeApp(t, { ready: true, detect: async () => calls++ });
    assert.equal((await app.inject('/healthz')).statusCode, 200);
    assert.equal((await app.inject('/readyz')).statusCode, 200);
    for (const headers of [{}, { authorization: 'Bearer wrong' }]) {
        assert.equal((await app.inject({ method: 'POST', url: '/v1/detect-language', headers, payload: 'bad' })).statusCode, 401);
    }
    assert.equal(calls, 0);
});

test('upload returns language only and rejects missing/empty/wrong field', async (t) => {
    const app = await makeApp(t);
    const response = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().language, 'en');
    assert.equal(response.json().text, undefined);
    for (const input of [multipart(Buffer.alloc(0)), multipart(Buffer.from('x'), 'wrong')]) {
        assert.equal((await app.inject({ method: 'POST', url: '/v1/detect-language', ...input })).statusCode, 422);
    }
});

test('file and raw-body limits reject oversized uploads, then slots recover', async (t) => {
    const app = await makeApp(t);
    for (const size of [config.maxUploadBytes + 1, config.maxUploadBytes + 65537]) {
        const response = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart(Buffer.alloc(size)) });
        assert.equal(response.statusCode, 413);
    }
    assert.equal((await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() })).statusCode, 200);
});

test('normal audio upload larger than stream buffer completes without stalling', async (t) => {
    const app = await makeApp(t);
    const response = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart(Buffer.alloc(200000)) });
    assert.equal(response.statusCode, 200);
});

test('extra files and form fields are rejected', async (t) => {
    const app = await makeApp(t);
    const extra = '--compac-test-boundary\r\nContent-Disposition: form-data; name="another"; filename="a.wav"\r\n\r\na\r\n';
    const response = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart(Buffer.from('x'), 'file', extra) });
    assert.ok([400, 413].includes(response.statusCode));
});

test('no-speech errors are structured and internal errors are sanitized', async (t) => {
    const detector = { ready: true, detect: async () => { throw new ServiceError('no_speech', 'Ucapan belum jelas.'); } };
    const app = await makeApp(t, detector);
    const response = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() });
    assert.equal(response.statusCode, 422);
    assert.equal(response.json().error.code, 'no_speech');
    detector.detect = async () => { throw new Error('sensitive-error'); };
    const failed = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() });
    assert.equal(failed.statusCode, 500);
    assert.equal(failed.body.includes('sensitive'), false);
});

test('busy admission keeps health responsive and recovers after inference', async (t) => {
    let release;
    let entered;
    const started = new Promise((resolve) => { entered = resolve; });
    const blocked = new Promise((resolve) => { release = resolve; });
    const app = await makeApp(t, { ready: true, detect: async () => { entered(); await blocked; return { language: 'en' }; } }, { maxInFlight: 1 });
    const first = app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() });
    await started;
    try {
        const busy = await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() });
        assert.equal(busy.statusCode, 429);
        assert.equal(busy.headers['retry-after'], '2');
        assert.equal((await app.inject('/healthz')).statusCode, 200);
    } finally { release(); }
    assert.equal((await first).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/detect-language', ...multipart() })).statusCode, 200);
});

test('CORS preflight accepts configured origins without API key', async (t) => {
    const app = await makeApp(t, undefined, { origins: ['https://compac.example'] });
    const response = await app.inject({ method: 'OPTIONS', url: '/v1/detect-language', headers: {
        origin: 'https://compac.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'Authorization',
    } });
    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'https://compac.example');
});

test('real decoder resamples stereo WAV to mono 16kHz', async () => {
    const audio = await decodeAudio(wav(2, 2, 48000), config);
    assert.equal(audio.length, 32000);
    assert.ok(audio.every((sample) => sample === 0));
});

test('real decoder rejects invalid, too short, and too long audio', async () => {
    for (const [input, code] of [[Buffer.from('invalid'), 'invalid_audio'], [wav(0.2), 'audio_too_short'], [wav(3), 'audio_too_long']]) {
        await assert.rejects(decodeAudio(input, { ...config, maxAudioSeconds: 2 }), { code });
    }
});

