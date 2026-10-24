// The BISON random forest as ONNX (ai.onnx.ml TreeEnsembleClassifier). ONNX Runtime is injected, so
// the same code runs on onnxruntime-node and onnxruntime-web. Input `X` [N, F] float32; outputs
// `label` (int64, sklearn predict, class 0 may occur) and `probabilities` [N, C], column c = class c.
// Rows go through in batches, so only one batch of features is held at a time.
import { checkImages, modeSpec, writeFeatures } from './features.js';

export const DEFAULT_BATCH_SIZE = 65536;

export async function createClassifier(ort, model, options = {}) {
  const session = await ort.InferenceSession.create(model, options);
  for (const name of ['label', 'probabilities']) {
    if (!session.outputNames.includes(name)) throw new Error(`The BISON model has no ${name} output.`);
  }
  return { Tensor: ort.Tensor, session };
}

export async function classifyVoxels(classifier, images, voxels, { batchSize = DEFAULT_BATCH_SIZE, onProgress, signal } = {}) {
  const spec = checkImages(images, images.t1.length);
  const classCount = modeSpec(images.mode).classes + 1;
  const { Tensor, session } = classifier;
  const total = voxels.length;
  const labels = new Uint8Array(total);
  const probabilities = new Float32Array(total * classCount);
  const buffer = new Float32Array(Math.min(batchSize, Math.max(total, 1)) * spec.features);
  for (let start = 0; start < total; start += batchSize) {
    signal?.throwIfAborted();
    const end = Math.min(start + batchSize, total);
    const rows = end - start;
    const features = rows * spec.features === buffer.length ? buffer : buffer.slice(0, rows * spec.features);
    writeFeatures(features, images, voxels, start, end);
    const input = new Tensor('float32', features, [rows, spec.features]);
    const output = await session.run({ X: input });
    const label = output.label;
    const probability = output.probabilities;
    if (label.data.length !== rows) throw new Error('The BISON model returned the wrong number of labels.');
    if (probability.dims[0] !== rows || probability.dims[1] !== classCount) {
      throw new Error(`The BISON model returned ${probability.dims[1]} classes, not ${classCount}.`);
    }
    for (let r = 0; r < rows; r++) {
      const value = Number(label.data[r]);
      if (!Number.isInteger(value) || value < 0 || value >= classCount) throw new Error(`The BISON model returned label ${value}.`);
      labels[start + r] = value;
    }
    probabilities.set(probability.data, start * classCount);
    input.dispose?.();
    label.dispose?.();
    probability.dispose?.();
    onProgress?.(end / total);
  }
  return { labels, probabilities, classCount };
}
