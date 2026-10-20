// The real pipeline worker, bundled with its scientific runtimes stubbed, run in Node against fake WebGPU
// adapters: the SynthSR step must take WASM on a software or undersized adapter and WebGPU otherwise.
import { test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const SHAPE = [160, 160, 224];
const ROOMY = { maxBufferSize: 4 * 2 ** 30, maxStorageBufferBindingSize: 4 * 2 ** 30 };

const stubs = {
  "@neurodesk/fastprep": `export async function runFastprep({ runtimes }) {
    await runtimes.synthsr(new Uint8Array(8));
    return { list: () => [], bytes: async () => new Uint8Array(0) };
  }`,
  "@neurodesk/webapp-components/worker": "export const fetchModel = async () => new ArrayBuffer(1);",
  "@neurodesk/greedy": "export const loadGreedy = async () => ({});",
  "@brainchop/mindgrab": "export const segment = () => {}; export const segmentTissues = () => {};",
  "@neurodesk/synthsr": `export async function runSynthsr({ options = {}, createSession }) {
    await createSession(new Uint8Array(1), options.backend, globalThis.synthsrShape);
    return { buffer: new ArrayBuffer(1) };
  }`,
  "onnxruntime-web/webgpu": `export const env = { wasm: {} };
    export class Tensor {}
    export const InferenceSession = { create: async (model, options) => { globalThis.ortSessions.push(options); return {}; } };`,
};

async function bundleWorker() {
  const dir = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "fastprep-worker-"));
  await mkdir(join(dir, "niimath"));
  await writeFile(join(dir, "niimath", "niimath.js"), "export default {};");
  const result = await build({
    entryPoints: [new URL("../src/pipeline-worker.js", import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    plugins: [{
      name: "stubs",
      setup(builder) {
        builder.onResolve({ filter: /\?url$/ }, (args) => ({ path: args.path, namespace: "stub" }));
        builder.onResolve({ filter: /^(@neurodesk\/(fastprep|webapp-components\/worker|greedy|synthsr)|@brainchop\/mindgrab|onnxruntime-web\/webgpu)$/ },
          (args) => ({ path: args.path, namespace: "stub" }));
        builder.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
          contents: args.path.endsWith("?url") ? "export default 'stub';" : stubs[args.path],
          resolveDir: new URL("../src/", import.meta.url).pathname,
        }));
      },
    }],
  });
  const file = join(dir, "pipeline-worker.mjs");
  await writeFile(file, result.outputFiles[0].text);
  return { file, base: `${pathToFileURL(dir).href}/` };
}

const worker = bundleWorker();

async function runSynthsrStep(adapter) {
  const { file, base } = await worker;
  const messages = [];
  globalThis.ortSessions = [];
  globalThis.synthsrShape = SHAPE;
  globalThis.self = { postMessage: (message) => messages.push(message) };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {
    hardwareConcurrency: 2,
    gpu: { requestAdapter: async () => adapter },
  } });
  await import(`${file}?${Math.random()}`);
  await globalThis.self.onmessage({ data: { base, dataset: {}, options: {} } });
  return { messages, ortSessions: globalThis.ortSessions };
}

test("the SynthSR step runs on WASM when the WebGPU adapter is a software fallback", async () => {
  const { messages, ortSessions } = await runSynthsrStep({ info: { isFallbackAdapter: true }, limits: ROOMY });
  assert.deepEqual(ortSessions, [{ executionProviders: ["wasm"], graphOptimizationLevel: "all" }], JSON.stringify(messages));
  assert.ok(messages.some((m) => m.done), JSON.stringify(messages));
  assert.ok(messages.some((m) => m.log === "SynthSR on wasm"), JSON.stringify(messages));
});

test("the SynthSR step runs on WASM when the adapter cannot bind the volume's largest buffer", async () => {
  const { messages, ortSessions } = await runSynthsrStep({ info: { isFallbackAdapter: false }, limits: { ...ROOMY, maxBufferSize: 2 ** 30 } });
  assert.equal(ortSessions.length, 1, JSON.stringify(messages));
  assert.ok(messages.some((m) => m.done), JSON.stringify(messages));
  assert.ok(messages.some((m) => m.log === "SynthSR on wasm"), JSON.stringify(messages));
});

test("the SynthSR step keeps WebGPU on a hardware adapter with room", async () => {
  // The GPU executor rejects the stub model bytes, which proves the WebGPU path was taken and ORT was not.
  const { messages, ortSessions } = await runSynthsrStep({ info: { isFallbackAdapter: false }, limits: ROOMY });
  assert.ok(messages.some((m) => /validated SynthSR model/.test(m.error ?? "")), JSON.stringify(messages));
  assert.deepEqual(ortSessions, []);
  assert.ok(messages.some((m) => m.log === "SynthSR on webgpu"), JSON.stringify(messages));
});
