import { spawn } from 'node:child_process';
import ffmpegStatic from 'ffmpeg-static';
import { ServiceError } from './errors.js';

export const SAMPLE_RATE = 16000;

export function decodeAudio(buffer, config) {
    return new Promise((resolve, reject) => {
        // No shell, no user-provided filename, and no network/file protocols in input.
        const child = spawn(config.ffmpegPath || ffmpegStatic, [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
            '-protocol_whitelist', 'pipe', '-i', 'pipe:0', '-map', '0:a:0',
            '-t', String(config.maxAudioSeconds + 1), '-vn', '-ac', '1',
            '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1',
        ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
        const chunks = [];
        let size = 0;
        let failure;
        const fail = (error) => {
            failure ??= error;
            child.kill('SIGKILL');
        };
        const timer = setTimeout(() => fail(new ServiceError('decode_timeout', 'Waktu pemrosesan audio habis.', 408)), 15000);
        child.on('error', () => {
            clearTimeout(timer);
            reject(new ServiceError('decoder_unavailable', 'Decoder audio belum tersedia di server.', 503));
        });
        child.stdout.on('data', (chunk) => {
            size += chunk.length;
            if (size > config.maxAudioSeconds * SAMPLE_RATE * 4) {
                fail(new ServiceError('audio_too_long', `Durasi audio maksimal ${config.maxAudioSeconds} detik.`));
            } else {
                chunks.push(chunk);
            }
        });
        child.stdin.on('error', () => {}); // Broken pipe when invalid input exits early.
        child.on('close', (code) => {
            clearTimeout(timer);
            if (failure) return reject(failure);
            if (code !== 0 || size % 4) return reject(new ServiceError('invalid_audio', 'Audio tidak valid atau tidak didukung.'));
            if (size < SAMPLE_RATE * 4) return reject(new ServiceError('audio_too_short', 'Kirim audio minimal 1 detik, idealnya 3–10 detik ucapan.'));
            const pcm = Buffer.concat(chunks);
            const samples = new Float32Array(size / 4);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = pcm.readFloatLE(i * 4);
                if (!Number.isFinite(samples[i])) return reject(new ServiceError('invalid_audio', 'Sampel audio tidak valid.'));
            }
            resolve(samples);
        });
        child.stdin.end(buffer);
    });
}
