// Module Web Worker executing the deterministic Dermoscope ABCD pipeline off the main thread.
import { runDermoscopyPipeline } from "@neurodesk/dermoscope/core/pipeline";

self.onmessage = ({ data }) => {
  const { id, rgba, width, height, settings } = data;
  try {
    const result = runDermoscopyPipeline(rgba, width, height, settings, {
      onProgress: (value, message) => {
        self.postMessage({ type: "progress", id, value, message });
      },
    });

    const transfer = [
      ...new Set(
        [
          result.workingOriginalRgba?.buffer,
          result.preprocessedRgba?.buffer,
          result.vignetteMask?.buffer,
          result.transparentMask?.buffer,
          result.validMask?.buffer,
          result.hairMask?.buffer,
          result.mask?.buffer,
          result.boundaryMask?.buffer,
          result.abcd?.color?.colorMap?.buffer,
        ].filter(Boolean),
      ),
    ];

    self.postMessage({ type: "result", id, result }, transfer);
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
