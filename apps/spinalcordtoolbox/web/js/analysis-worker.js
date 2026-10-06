import { runBrowserSct } from './app/browser-runtime.js';

self.onmessage = async ({ data }) => {
    try {
        const outputs = await runBrowserSct({
            ...data,
            baseUrl: new URL('../python/', import.meta.url).href,
            onProgress: progress => self.postMessage({ type: 'progress', ...progress }),
            onLog: line => self.postMessage({ type: 'log', line }),
        });
        self.postMessage({ type: 'result', outputs }, outputs.map(output => output.bytes.buffer));
    } catch (error) {
        self.postMessage({ type: 'error', message: error.message });
    }
};
