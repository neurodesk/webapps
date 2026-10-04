import { build } from 'esbuild';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

export async function inferenceWorker(app, globals = {}) {
  const messages = [];
  const result = await build({
    entryPoints: [`apps/${app}/src/inference-worker.js`],
    bundle: true,
    write: false,
    format: 'iife',
    plugins: [{
      name: 'scientific-stubs',
      setup(builder) {
        builder.onResolve({ filter: /^(@neurodesk\/synth(sr|seg)|onnxruntime-web)/ }, args => ({ path: args.path, namespace: 'science' }));
        builder.onLoad({ filter: /.*/, namespace: 'science' }, args => {
          if (args.path.endsWith('?url')) return { contents: 'export default "https://example.org/runtime";' };
          if (args.path.includes('/browser')) return { contents: 'export const browserRuntime = () => ({}); export const createBrowserSession = async () => ({});' };
          if (args.path.startsWith('onnxruntime')) return { contents: 'export const env = { wasm: {} }; export class Tensor {}' };
          return { contents: `
            export const loadSynthseg = async () => ({});
            async function run({ loadModel }) {
              const model = await loadModel();
              globalThis.loadedModel = model;
              return { buffer: new ArrayBuffer(1), provenance: { hash: model.hash } };
            }
            export { run as runSynthsr, run as runSynthseg };
          ` };
        });
      },
    }],
  });
  const context = vm.createContext({
    ArrayBuffer, Uint8Array, Response, Headers, crypto: webcrypto,
    navigator: { hardwareConcurrency: 1 },
    fetch: async () => new Response(new Uint8Array([1, 2, 3])),
    ...globals,
    self: { postMessage: message => messages.push(message) },
  });
  vm.runInContext(result.outputFiles[0].text, context);
  return {
    messages,
    context,
    async run(model) {
      await context.self.onmessage({ data: { model, options: { backend: 'wasm' }, file: { arrayBuffer: async () => new ArrayBuffer(1) } } });
    },
  };
}
