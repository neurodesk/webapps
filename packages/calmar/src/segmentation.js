import { runInferencePipeline } from './inference-pipeline.js';
import { collapseBinarySoftmaxLogits, shouldUseZYXModelAxisOrder } from './inference-numerics.js';
import { resampleVolume, resampleLabelsNearest } from './volume-utils.js';

// The worker and CPU command line inject the same patch evaluator.
export async function segmentCandidate(volume, entry, runPatch, onProgress = () => {}) {
  const targetSpacing = entry.preprocessing?.targetSpacing;
  const resampled = targetSpacing
    ? resampleVolume(
        volume.data,
        volume.dims,
        volume.spacing,
        targetSpacing.map((value, index) => value ?? volume.spacing[index])
      )
    : volume;
  if (shouldUseZYXModelAxisOrder(entry.preprocessing || {}, resampled.dims, entry.patchSize)) {
    throw new Error('This segmentation model axis order is not supported by the T1 command line.');
  }
  const result = await runInferencePipeline(
    { data: resampled.data, dims: resampled.dims, patchSize: entry.patchSize },
    async (patch, dims) => {
      const raw = await runPatch(patch, dims);
      return collapseBinarySoftmaxLogits(
        raw,
        dims.reduce((a, b) => a * b, 1)
      );
    },
    {
      overlap: entry.overlap ?? 0.25,
      threshold: entry.probabilityThreshold ?? 0.4,
      minComponentSize: entry.minComponentSize ?? 30,
      testTimeAugmentation: entry.testTimeAugmentation ?? true,
      onProgress,
    }
  );
  return {
    data: resampleLabelsNearest(result.labels, result.dims, volume.dims),
    dims: volume.dims,
    affine: volume.affine,
    spacing: volume.spacing,
  };
}
