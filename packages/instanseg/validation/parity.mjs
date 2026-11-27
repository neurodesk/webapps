// Parity check: runs @neurodesk/instanseg (JS + onnxruntime-node) against upstream
// InstanSeg brightfield_nuclei TorchScript oracles (single-tile and seam-crossing tiled).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ort from 'onnxruntime-node';
import { readBrightfieldImage } from '../src/image-io.js';
import { segmentBrightfieldNuclei } from '../src/pipeline.js';
import { compareInstanceLabels, measureNuclei } from '../src/results.js';

function parseNpyInt32(buf) {
  const magic = String.fromCharCode(...buf.subarray(0, 6));
  if (magic !== '\x93NUMPY') throw new Error('Expected .npy file');
  const major = buf[6];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hdrLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const offset = (major === 1 ? 10 : 12) + hdrLen;
  const hdr = new TextDecoder().decode(buf.subarray(major === 1 ? 10 : 12, offset));
  const shapeMatch = hdr.match(/'shape':\s*\(([^)]+)\)/);
  const dims = shapeMatch[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const isFloat = hdr.includes('<f4');
  const slice = buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + buf.byteLength);
  const data = isFloat ? Int32Array.from(new Float32Array(slice), (v) => Math.round(v)) : new Int32Array(slice);
  return { dims, data };
}

const args = process.argv.slice(2);
let pixelSizeOverride = null;
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--pixel-size' && args[i + 1]) {
    pixelSizeOverride = Number(args[++i]);
  } else {
    positional.push(args[i]);
  }
}
const [imagePath, onnxPath, oracleNpyPath] = positional;
if (!imagePath || !onnxPath || !oracleNpyPath) {
  console.error('Usage: node parity.mjs [--pixel-size <um>] <image.tif|.png|.npy> <model.onnx> <oracle.npy>');
  process.exit(2);
}

let rgbChw;
let width;
let height;
let pixelSize = null;
if (imagePath.endsWith('.npy')) {
  const buf = await readFile(imagePath);
  const major = buf[6];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hdrLen = major === 1 ? dv.getUint16(8, true) : dv.getUint32(8, true);
  const offset = (major === 1 ? 10 : 12) + hdrLen;
  const hdr = new TextDecoder().decode(buf.subarray(major === 1 ? 10 : 12, offset));
  const dims = hdr.match(/'shape':\s*\(([^)]+)\)/)[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  height = dims[dims.length - 2];
  width = dims[dims.length - 1];
  rgbChw = new Float32Array(buf.buffer.slice(buf.byteOffset + offset, buf.byteOffset + buf.byteLength));
} else {
  const bytes = await readFile(imagePath);
  const img = await readBrightfieldImage(imagePath, bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  ({ rgbChw, width, height, pixelSize } = img);
}
if (pixelSizeOverride !== null && Number.isFinite(pixelSizeOverride)) {
  pixelSize = pixelSizeOverride;
}

const oracle = parseNpyInt32(await readFile(oracleNpyPath));
const session = await ort.InferenceSession.create(onnxPath);
const started = performance.now();
const result = await segmentBrightfieldNuclei({
  rgbChw,
  width,
  height,
  pixelSize,
  runFcn: async (padded, paddedH, paddedW) => {
    const input = new ort.Tensor('float32', padded, [1, 3, paddedH, paddedW]);
    const out = await session.run({ [session.inputNames[0]]: input });
    return out[session.outputNames[0]].data;
  },
});
const seconds = (performance.now() - started) / 1000;
const cmp = compareInstanceLabels(result.labels, oracle.data);
const nuclei = measureNuclei(result.labels, width, height, pixelSize);

console.log(JSON.stringify({
  image: imagePath,
  dims: [width, height],
  pixelSize,
  tiles: result.tiles,
  seconds: Number(seconds.toFixed(2)),
  nucleiMeasured: nuclei.length,
  ...cmp,
}, null, 2));

assert.ok(cmp.f1At50 >= 0.999, `F1@0.50 too low: ${cmp.f1At50}`);
assert.ok(cmp.f1At90 >= 0.999, `F1@0.90 too low: ${cmp.f1At90}`);
assert.ok(cmp.meanMatchedIou >= 0.999, `Mean matched IoU too low: ${cmp.meanMatchedIou}`);
assert.ok(cmp.foregroundDice >= 0.999, `Foreground Dice too low: ${cmp.foregroundDice}`);
