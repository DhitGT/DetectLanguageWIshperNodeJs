import { resolve } from 'node:path';

export function readConfig(env = process.env) {
    const number = (key, fallback, min, max, integer = false) => {
        const value = Number(env[key] ?? fallback);
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
            throw new Error(`Konfigurasi ${key} tidak valid.`);
        }
        return value;
    };
    const apiKey = (env.API_KEY ?? '').trim();
    if (apiKey.length < 32 || apiKey.startsWith('CHANGE_ME')) {
        throw new Error('Isi API_KEY dengan secret acak minimal 32 karakter.');
    }
    const model = env.WHISPER_MODEL || 'onnx-community/whisper-base';
    if (model.endsWith('.en')) throw new Error('Gunakan model Whisper multilingual, bukan .en.');
    const origins = (env.CORS_ORIGINS || '').split(',').map((value) => value.trim()).filter(Boolean);
    if (origins.includes('*')) throw new Error('CORS_ORIGINS harus berisi origin spesifik.');
    return {
        apiKey, model, origins,
        host: env.HOST || '127.0.0.1',
        port: number('PORT', 8000, 1, 65535, true),
        cacheDir: resolve(env.MODEL_CACHE || './models'),
        ffmpegPath: env.FFMPEG_PATH || undefined,
        cpuThreads: number('CPU_THREADS', 4, 1, 64, true),
        maxUploadBytes: number('MAX_UPLOAD_MB', 8, 1, 32, true) * 1024 * 1024,
        maxAudioSeconds: number('MAX_AUDIO_SECONDS', 30, 2, 30, true),
        minSpeechSeconds: number('MIN_SPEECH_SECONDS', 0.6, 0.2, 5),
        minConfidence: number('MIN_CONFIDENCE', 0.7, 0, 1),
        maxInFlight: number('MAX_IN_FLIGHT', 2, 1, 16, true),
    };
}
