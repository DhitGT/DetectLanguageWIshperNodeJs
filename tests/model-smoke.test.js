import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readConfig } from '../src/config.js';
import { Detector } from '../src/detector.js';
import { createApp } from '../src/app.js';

test('real Whisper and VAD detect uploaded audio through HTTP', { skip: !process.env.SMOKE_AUDIO_FILE, timeout: 600000 }, async (t) => {
    const config = readConfig({ ...process.env, API_KEY: 'smoke-secret-key-at-least-32-characters' });
    const detector = new Detector();
    t.after(() => detector.close());
    await detector.start(config);
    console.log('Model worker ready');
    const app = await createApp(config, detector);
    app.log.level = 'silent';
    t.after(() => app.close());
    const form = new FormData();
    form.append('file', new Blob([await readFile(process.env.SMOKE_AUDIO_FILE)]), 'sample.flac');
    const request = new Request('http://localhost/v1/detect-language', { method: 'POST', body: form });
    console.log('Sending real audio upload');
    const response = await app.inject({ method: 'POST', url: '/v1/detect-language', headers: {
        authorization: `Bearer ${config.apiKey}`, 'content-type': request.headers.get('content-type'),
    }, payload: Buffer.from(await request.arrayBuffer()) });
    console.log('HTTP status', response.statusCode);
    assert.equal(response.statusCode, 200, response.body);
    const result = response.json();
    console.log(result);
    assert.equal(result.status, 'detected');
    assert.equal(result.language, process.env.SMOKE_EXPECTED_LANGUAGE || 'en');
    assert.equal(result.text, undefined);
});
