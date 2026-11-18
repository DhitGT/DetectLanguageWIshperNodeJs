import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import * as ort from 'onnxruntime-node';

const URL = 'https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx';
const HASH = '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f';

export async function loadVad(cacheDir) {
    await mkdir(cacheDir, { recursive: true });
    const path = join(cacheDir, 'silero-v5.1.2.onnx');
    let data;
    try { data = await readFile(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!data) {
        const response = await fetch(URL, { signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw new Error('Unduhan model VAD gagal.');
        data = Buffer.from(await response.arrayBuffer());
    }
    if (createHash('sha256').update(data).digest('hex') !== HASH) throw new Error('Checksum model VAD tidak sesuai.');
    // Atomic cache writes. No audio is written to disk.
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, data);
    await rename(temporary, path);
    return ort.InferenceSession.create(data, { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 });
}

export function speechRegions(probabilities, length) {
    const regions = [];
    let start = null;
    let voicedSamples = 0;
    const finish = (end) => {
        if (start !== null && end - start >= 3 * 512) {
            voicedSamples += Math.min(end, length) - start;
            const padded = { start: Math.max(0, start - 1600), end: Math.min(length, end + 1600) };
            const previous = regions.at(-1);
            if (previous && padded.start <= previous.end) previous.end = padded.end;
            else regions.push(padded);
        }
        start = null;
    };
    for (let i = 0; i < probabilities.length; i++) {
        if (probabilities[i] >= 0.5) start ??= i * 512;
        else finish(i * 512);
    }
    finish(probabilities.length * 512);
    return { regions, voicedSamples };
}

export async function filterSpeech(audio, session) {
    // Recurrent state and 64-sample context belong to this recording only.
    let state = new Float32Array(256);
    const probabilities = [];
    for (let offset = 0; offset < audio.length; offset += 512) {
        const input = new Float32Array(576);
        if (offset) input.set(audio.subarray(offset - 64, offset));
        input.set(audio.subarray(offset, offset + 512), 64);
        const feeds = {
            input: new ort.Tensor('float32', input, [1, 576]),
            state: new ort.Tensor('float32', state, [2, 1, 128]),
            sr: new ort.Tensor('int64', BigInt64Array.from([16000n]), []),
        };
        let output;
        try {
            output = await session.run(feeds);
            probabilities.push(Number(output.output.data[0]));
            state = Float32Array.from(output.stateN.data);
        } finally {
            for (const tensor of [...Object.values(feeds), ...Object.values(output ?? {})]) tensor.dispose();
        }
    }
    const { regions, voicedSamples } = speechRegions(probabilities, audio.length);
    const speech = new Float32Array(regions.reduce((sum, item) => sum + item.end - item.start, 0));
    let offset = 0;
    for (const region of regions) {
        speech.set(audio.subarray(region.start, region.end), offset);
        offset += region.end - region.start;
    }
    return { speech, speechSeconds: voicedSamples / 16000 };
}
