import { readConfig } from './config.js';
import { Detector } from './detector.js';
import { createApp } from './app.js';

const config = readConfig();
const detector = new Detector();
console.info('Memuat model bahasa; startup pertama mengunduh model ke cache.');
try {
    await detector.start(config);
    const app = await createApp(config, detector);
    const shutdown = async () => {
        await app.close();
        await detector.close();
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
    await app.listen({ host: config.host, port: config.port });
} catch (error) {
    console.error(error.message);
    await detector.close();
    process.exitCode = 1;
}
