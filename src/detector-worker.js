import { parentPort, workerData } from 'node:worker_threads';
import { AutoProcessor, WhisperForConditionalGeneration, Tensor, env } from '@huggingface/transformers';
import { loadVad, filterSpeech } from './vad.js';
import { formatResult, languageProbabilities } from './language.js';
import { ServiceError } from './errors.js';

const config = workerData;
env.cacheDir = config.cacheDir;
const processor = await AutoProcessor.from_pretrained(config.model);
const model = await WhisperForConditionalGeneration.from_pretrained(config.model, {
    dtype: 'q8', device: 'cpu',
    session_options: { intraOpNumThreads: config.cpuThreads, interOpNumThreads: 1 },
});
const generation = model.generation_config;
if (!generation?.lang_to_id || !generation?.is_multilingual) throw new Error('Model Whisper multilingual dengan metadata bahasa diperlukan.');
const vad = await loadVad(config.cacheDir);

function dispose(value, seen = new Set()) {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (value instanceof Tensor) value.dispose();
    else if (!ArrayBuffer.isView(value)) for (const item of Object.values(value)) dispose(item, seen);
}

async function detect(audio) {
    const started = performance.now();
    const { speech, speechSeconds } = await filterSpeech(audio, vad);
    if (speechSeconds < config.minSpeechSeconds) throw new ServiceError('no_speech', 'Ucapan belum cukup jelas. Kirim potongan suara yang lebih panjang.');
    const inputs = await processor(speech);
    const decoderInput = new Tensor('int64', BigInt64Array.from([BigInt(generation.decoder_start_token_id)]), [1, 1]);
    let output;
    try {
        // Bypass generate(): read language logits after start-of-transcript only.
        output = await model({ input_features: inputs.input_features, decoder_input_ids: decoderInput });
        const probabilities = languageProbabilities(output.logits.data, generation.lang_to_id);
        return formatResult(probabilities, config.minConfidence, audio.length / 16000, speechSeconds, performance.now() - started);
    } finally {
        dispose(inputs);
        dispose(decoderInput);
        dispose(output);
    }
}

let queue = Promise.resolve();
parentPort.on('message', ({ id, audio }) => {
    queue = queue.then(async () => {
        try {
            parentPort.postMessage({ id, result: await detect(audio) });
        } catch (error) {
            parentPort.postMessage({ id, error: error instanceof ServiceError
                ? { code: error.code, message: error.message, statusCode: error.statusCode }
                : { code: 'inference_failed', message: 'Deteksi bahasa gagal.', statusCode: 500 } });
        }
    });
});
parentPort.postMessage({ ready: true });
