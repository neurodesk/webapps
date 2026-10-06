// @neurodesk/white-matter-lesions against reference.py on the same skull-stripped input and ONNX model.
//
//   node validation/parity.mjs <stripped FLAIR> <reference.py mask> <model.onnx>
//
// Runs ONNX Runtime Web's WebAssembly backend in Node, so it also checks that runtime.
import * as ort from "onnxruntime-web";
import { readFileSync } from "node:fs";
import { readVolume } from "@neurodesk/synthsr";
import { PLAN, segmentFlair, threshold } from "@neurodesk/white-matter-lesions";

const [flairPath, referencePath, modelPath] = process.argv.slice(2);
const bytes = (path) => {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
};
ort.env.wasm.numThreads = 8;
const volume = readVolume(bytes(flairPath));
const reference = readVolume(bytes(referencePath));
const session = await ort.InferenceSession.create(readFileSync(modelPath), { executionProviders: ["wasm"] });
const started = performance.now();
const { probability, windows } = await segmentFlair({
  volume,
  brainMask: Uint8Array.from(volume.data, (v) => (v !== 0 ? 1 : 0)),
  runPatch: async (tile) => (await session.run({ input: new ort.Tensor("float32", tile, [1, 1, ...PLAN.patch]) })).logits.data,
});
const mask = threshold(probability);
let js = 0;
let python = 0;
let both = 0;
for (let i = 0; i < mask.length; i++) {
  const r = reference.data[i] > 0 ? 1 : 0;
  js += mask[i];
  python += r;
  both += mask[i] & r;
}
console.log(JSON.stringify({ windows, seconds: Math.round((performance.now() - started) / 100) / 10, js, python, dice: js + python ? 2 * both / (js + python) : 1, differing: js + python - 2 * both }));
