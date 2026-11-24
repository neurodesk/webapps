// Python Cellpose 3.1.1.1 reference results (validation/reference.json) and instance IoU
// matching for comparing the browser's label TIFFs against Python Cellpose.
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { fromArrayBuffer } from "geotiff";

export const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));
export const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));

export function decodeReferenceLabels(caseKey) {
  const b64 = reference.cases[caseKey].labels_u32_zlib_b64;
  const raw = inflateSync(Buffer.from(b64, "base64"));
  return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

export async function readLabelTiff(bytes) {
  const tiff = await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const depth = await tiff.getImageCount();
  const first = await tiff.getImage(0);
  const width = first.getWidth();
  const height = first.getHeight();
  if (depth === 1) {
    const [values] = await first.readRasters();
    return { width, height, depth: 1, labels: Int32Array.from(values) };
  }
  const plane = width * height;
  const labels = new Int32Array(depth * plane);
  for (let z = 0; z < depth; z++) {
    const page = z === 0 ? first : await tiff.getImage(z);
    const [values] = await page.readRasters();
    labels.set(values, z * plane);
  }
  return { width, height, depth, labels };
}

export function matchLabels(truth, pred, thresh = 0.5) {
  const overlap = new Map();
  const areaTrue = new Map();
  const areaPred = new Map();
  for (let i = 0; i < truth.length; i++) {
    const t = truth[i];
    const p = pred[i];
    if (t) areaTrue.set(t, (areaTrue.get(t) ?? 0) + 1);
    if (p) areaPred.set(p, (areaPred.get(p) ?? 0) + 1);
    if (t && p) overlap.set(`${t},${p}`, (overlap.get(`${t},${p}`) ?? 0) + 1);
  }
  let tp = 0;
  let iouSum = 0;
  for (const [key, inter] of overlap) {
    const [t, p] = key.split(",").map(Number);
    const iou = inter / (areaTrue.get(t) + areaPred.get(p) - inter);
    if (iou >= thresh) {
      tp++;
      iouSum += iou;
    }
  }
  const nTrue = areaTrue.size;
  const nPred = areaPred.size;
  return { tp, nTrue, nPred, f1: (2 * tp) / (nTrue + nPred), meanMatchedIou: tp ? iouSum / tp : 0 };
}
