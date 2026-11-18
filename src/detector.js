import { Worker } from 'node:worker_threads';
import { ServiceError } from './errors.js';

export class Detector {
    pending = new Map();
    sequence = 0;
    ready = false;

    async start(config) {
        // Do not include API credentials in workerData.
        const { apiKey, ...workerConfig } = config;
        this.worker = new Worker(new URL('./detector-worker.js', import.meta.url), {
            workerData: workerConfig, stdout: true, stderr: true, execArgv: [],
        });
        // Runtime error dumps may contain feature tensors; never forward them to logs.
        this.worker.stdout.resume();
        this.worker.stderr.resume();
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.worker.terminate();
                reject(new Error('Startup model melebihi 10 menit. Periksa jaringan/cache model.'));
            }, 600000);
            const fail = (error) => {
                clearTimeout(timer);
                this.ready = false;
                reject(new Error(`Worker model gagal saat startup: ${error?.message || 'worker berhenti'}`));
                for (const job of this.pending.values()) job.reject(new ServiceError('worker_unavailable', 'Worker model tidak tersedia.', 503));
                this.pending.clear();
            };
            this.worker.on('error', fail);
            this.worker.on('exit', fail);
            this.worker.on('message', (message) => {
                if (message.ready) {
                    clearTimeout(timer);
                    this.ready = true;
                    resolve();
                    return;
                }
                const job = this.pending.get(message.id);
                if (!job) return;
                this.pending.delete(message.id);
                if (message.error) job.reject(new ServiceError(message.error.code, message.error.message, message.error.statusCode));
                else job.resolve(message.result);
            });
        });
    }

    detect(audio) {
        if (!this.ready) return Promise.reject(new ServiceError('worker_unavailable', 'Worker model belum siap.', 503));
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            this.worker.postMessage({ id, audio }, [audio.buffer]);
        });
    }

    async close() {
        this.ready = false;
        await this.worker?.terminate();
    }
}
