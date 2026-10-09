// Brain-masks a FLAIR with the app's SynthStrip port, the input validation/reference.py expects.
//
//   node validation/strip_example.mjs <FLAIR.nii.gz> <synthstrip-browser.onnx> <stripped.nii.gz>
//
// Voxels outside the SynthStrip mask become zero; nothing else changes. Runs ONNX Runtime Web's
// WebAssembly backend in Node, as the app's worker does in the browser.
import * as ort from "onnxruntime-web";
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { readVolume, writeVolume } from "@neurodesk/synthsr";
import { runSynthstrip } from "@neurodesk/synthstrip";

const [flairPath, modelPath, outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("Usage: strip_example.mjs <FLAIR.nii.gz> <synthstrip-browser.onnx> <stripped.nii.gz>");
const bytes = (path) => {
  const buffer = readFileSync(path);
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length);
};
ort.env.wasm.numThreads = 8;
const volume = readVolume(bytes(flairPath));
const { mask } = await runSynthstrip({
  volume,
  loadModel: async () => ({ bytes: readFileSync(modelPath), hash: "local" }),
  createSession: (model) => ort.InferenceSession.create(model, { executionProviders: ["wasm"], graphOptimizationLevel: "all" }),
  Tensor: ort.Tensor,
});
const data = Float32Array.from(volume.data, (value, index) => (mask.data[index] ? value : 0));
const brainVoxels = mask.data.reduce((sum, value) => sum + (value ? 1 : 0), 0);
writeFileSync(outputPath, gzipSync(Buffer.from(writeVolume({ ...volume, data }, "FLAIR inside the SynthStrip mask")), { level: 9 }));
console.log(JSON.stringify({ brainVoxels, voxels: data.length }));
