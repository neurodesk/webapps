// Web Worker executing the pure DOM-free wound planimetry pipeline and PNG encoding.
import { MAX_IMAGE_PIXELS } from "./config.js";
import { rgbaToColorArrays } from "./core/color.js";
import { segmentWound } from "./core/segment.js";
import { measurePlanimetry } from "./core/planimetry.js";
import { classifyRyb } from "./core/ryb.js";
import { encodeMaskPng, encodeRybOverlayPng } from "./outputs.js";

function ownBytes(bytes) {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? bytes
    : bytes.slice();
}

self.onmessage = ({ data }) => {
  const { id, type } = data;
  if (type !== "measure") return;

  try {
    const started = performance.now();
    const { rgba, width, height, params, seed, overlayOpacity = 0.55 } = data;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error("Invalid image dimensions.");
    }
    if (width * height > MAX_IMAGE_PIXELS) {
      throw new Error(`Image exceeds the ${MAX_IMAGE_PIXELS.toLocaleString()} pixel analysis limit.`);
    }

    self.postMessage({ type: "progress", value: 0.15, message: "Converting image to CIE L*a*b*…" });
    const colors = rgbaToColorArrays(rgba, width, height);

    self.postMessage({ type: "progress", value: 0.42, message: "Segmenting wound bed…" });
    const { mask, otsuThreshold, threshold, seedFallback } = segmentWound(colors, width, height, {
      sensitivity: params.sensitivity,
      seed,
    });

    self.postMessage({ type: "progress", value: 0.65, message: "Measuring planimetry geometry…" });
    const { boundary, ...planimetry } = measurePlanimetry(mask, width, height, params.pixelsPerMm, colors.opaque);

    self.postMessage({ type: "progress", value: 0.8, message: "Estimating color-based RYB tissues…" });
    const { labels: rybLabels, ...ryb } = classifyRyb(colors, mask, {
      escharL: params.escharL,
      granulationA: params.granulationA,
      sloughB: params.sloughB,
      pixelsPerMm: params.pixelsPerMm,
    });

    self.postMessage({ type: "progress", value: 0.92, message: "Encoding PNG outputs…" });
    const rybPngBytes = ownBytes(encodeRybOverlayPng(rgba, rybLabels, boundary, width, height, overlayOpacity));
    const maskPngBytes = ownBytes(encodeMaskPng(mask, width, height));

    const elapsedMs = performance.now() - started;
    self.postMessage(
      {
        id,
        type: "result",
        mask,
        boundary,
        rybLabels,
        rybPngBytes,
        maskPngBytes,
        planimetry,
        ryb,
        otsuThreshold,
        threshold,
        seedUsed: seed ?? null,
        seedFallback,
        elapsedMs,
      },
      [mask.buffer, boundary.buffer, rybLabels.buffer, rybPngBytes.buffer, maskPngBytes.buffer],
    );
  } catch (error) {
    self.postMessage({
      id,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
