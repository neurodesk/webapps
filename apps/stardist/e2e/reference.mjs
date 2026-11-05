// Python StarDist's result on the example (validation/reference.json) and the IoU matching
// stardist.matching uses, for comparing the browser's labels with it.
import { readFileSync } from "node:fs";
import { fromArrayBuffer } from "geotiff";
import { renderLabels } from "../src/stardist.js";

export const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));
export const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));

function decode(base64, Type) {
  const bytes = Buffer.from(base64, "base64");
  return new Type(bytes.buffer, bytes.byteOffset, bytes.byteLength / Type.BYTES_PER_ELEMENT);
}

/** The label image Python StarDist 0.9.1 gives on the example (no tiling). */
export function referenceLabels() {
  const example = reference.example["1x1"];
  const [height, width] = reference.shape;
  return renderLabels(decode(example.coord, Float32Array), decode(example.prob, Float32Array), 32, height, width);
}

export async function readLabelTiff(bytes) {
  const image = await (await fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))).getImage();
  const [values] = await image.readRasters();
  return { width: image.getWidth(), height: image.getHeight(), labels: Int32Array.from(values) };
}

/**
 * stardist.matching.matching(truth, pred, thresh): pairs whose IoU reaches the threshold (unique
 * for thresholds of 0.5 and above), and the F1 score of those matches.
 */
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
