import { validateSctSpec } from './analysis-spec.js';

export function createBrowserAnalysisRunner({ createWorker = () => new Worker(new URL('../analysis-worker.js', import.meta.url), { type: 'module' }) } = {}) {
    let active = null;
    return {
        run({ spec, files, onProgress = () => {}, onLog = () => {} }) {
            if (active) return Promise.reject(new Error('An analysis is already running'));
            const validated = validateSctSpec(spec, Object.keys(files));
            return new Promise((resolve, reject) => {
                const worker = createWorker();
                const finish = (error, outputs) => {
                    if (active?.worker !== worker) return;
                    active = null;
                    worker.terminate();
                    if (error) reject(error);
                    else resolve(outputs);
                };
                active = { worker, finish };
                worker.onmessage = ({ data }) => {
                    if (active?.worker !== worker) return;
                    if (data.type === 'progress') onProgress(data);
                    else if (data.type === 'log') onLog({ line: data.line });
                    else if (data.type === 'result') finish(null, data.outputs);
                    else if (data.type === 'error') finish(new Error(data.message));
                };
                worker.onerror = event => finish(new Error(event.message || 'Browser analysis worker failed'));
                void Promise.all(Object.entries(files).map(async ([role, file]) => {
                    if (!/\.nii(?:\.gz)?$/i.test(file.name)) throw new Error('Choose a NIfTI mask (.nii or .nii.gz)');
                    return { role, name: role + (/\.gz$/i.test(file.name) ? '.nii.gz' : '.nii'), bytes: new Uint8Array(await file.arrayBuffer()) };
                })).then(inputs => {
                    if (active?.worker === worker) worker.postMessage({ spec: validated, inputs }, inputs.map(input => input.bytes.buffer));
                }).catch(error => finish(error));
            });
        },
        cancel() {
            active?.finish(new DOMException('Analysis cancelled', 'AbortError'));
        },
    };
}
