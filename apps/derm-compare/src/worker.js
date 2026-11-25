// Web Worker executing uniform pair downscaling, preprocessing, multi-scale NCC registration,
// CIEDE2000 analysis, and PNG artifact encoding off the main thread.
import { LIMITS } from "./config.js";
import { runComparison } from "@neurodesk/derm-compare/core/pipeline";
import { buildChangeMapRgba } from "./display.js";
import { encodeRgbaPng } from "./outputs.js";

self.onmessage = ({ data }) => {
  if (data.type !== "compare") return;
  try {
    const started = performance.now();
    const {
      baselineRgba,
      baselineWidth,
      baselineHeight,
      followupRgba,
      followupWidth,
      followupHeight,
      settings,
    } = data;

    const basePixels = new Uint8ClampedArray(baselineRgba);
    const follPixels = new Uint8ClampedArray(followupRgba);

    const result = runComparison({
      baselineRgba: basePixels,
      baselineWidth,
      baselineHeight,
      followupRgba: follPixels,
      followupWidth,
      followupHeight,
      settings,
      maxWorkingDimension: LIMITS.maxWorkingDimension,
      onProgress: (value, message) => {
        self.postMessage({ type: "progress", value: value * 0.9, message });
      },
    });

    if (!result.registered) {
      self.postMessage({
        type: "error",
        code: "REGISTRATION_FAILED",
        message: result.reason || "Insufficient image texture or overlap for registration",
      });
      return;
    }

    self.postMessage({ type: "progress", value: 0.92, message: "Encoding PNG outputs…" });
    const changeMapRgba = buildChangeMapRgba({
      baselineRgba: result.baselineRgba,
      deltaEMap: result.deltaEMap,
      validMask: result.validMask,
      deltaEMask: result.deltaEMask,
      baselineMask: result.baselineMask,
      followupMask: result.followupMask,
      width: result.width,
      height: result.height,
      opacity: 0.72,
      showContours: true,
    });
    const alignedPng = encodeRgbaPng(result.warpedFollowupRgba, result.width, result.height);
    const changeMapPng = encodeRgbaPng(changeMapRgba, result.width, result.height);
    const elapsedSeconds = (performance.now() - started) / 1000;

    self.postMessage(
      {
        type: "result",
        width: result.width,
        height: result.height,
        followupWidth: result.followupWidth,
        followupHeight: result.followupHeight,
        workingScale: result.workingScale,
        baselineRgba: result.baselineRgba,
        warpedFollowupRgba: result.warpedFollowupRgba,
        overlapMask: result.overlapMask,
        validMask: result.validMask,
        deltaEMask: result.deltaEMask,
        deltaEMap: result.deltaEMap,
        baselineMask: result.baselineMask,
        followupMask: result.followupMask,
        preprocessing: result.preprocessing,
        registration: result.registration,
        metrics: result.metrics,
        alignedPng,
        changeMapPng,
        elapsedSeconds,
      },
      [
        result.baselineRgba.buffer,
        result.warpedFollowupRgba.buffer,
        result.overlapMask.buffer,
        result.validMask.buffer,
        result.deltaEMask.buffer,
        result.deltaEMap.buffer,
        result.baselineMask.buffer,
        result.followupMask.buffer,
        alignedPng.buffer,
        changeMapPng.buffer,
      ],
    );
  } catch (error) {
    self.postMessage({
      type: "error",
      message: error?.message || "Comparison worker failed.",
    });
  }
};
