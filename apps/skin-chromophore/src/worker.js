// Web Worker for skin chromophore and colorimetry analysis, PNG map encoding, and ROI recompute.
// Pure module worker: no window/document access.
import { analyzeSkinImage, evaluateRois } from "@neurodesk/skin-chromophore/core/analyze";
import { encodeMapPng } from "./outputs.js";

let activeState = null;

self.onmessage = ({ data }) => {
  try {
    if (data.type === "analyze") {
      const result = analyzeSkinImage(
        data.rgba,
        data.width,
        data.height,
        data.options,
        (value, message) => self.postMessage({ type: "progress", id: data.id, value: value * 0.84, message }),
      );
      self.postMessage({ type: "progress", id: data.id, value: 0.88, message: "Encoding hemoglobin proxy PNG…" });
      const hemoglobin = encodeMapPng("hemoglobin", result);
      self.postMessage({ type: "progress", id: data.id, value: 0.92, message: "Encoding melanin proxy PNG…" });
      const melanin = encodeMapPng("melanin", result);
      self.postMessage({ type: "progress", id: data.id, value: 0.96, message: "Encoding ITA° typology PNG…" });
      const ita = encodeMapPng("ita", result);

      // Retain working maps & validMask on the worker for off-main-thread ROI recomputation.
      activeState = {
        width: result.width,
        height: result.height,
        validMask: result.validMask,
        validCount: result.validCount,
        maps: result.maps,
      };

      const transfer = Array.from(new Set([
        result.alphaMask.buffer,
        result.roi.targetMask.buffer,
        result.roi.referenceMask.buffer,
        hemoglobin.buffer,
        melanin.buffer,
        ita.buffer,
      ]));

      self.postMessage(
        {
          type: "result",
          id: data.id,
          result,
          pngs: { hemoglobin, melanin, ita },
        },
        transfer,
      );
      return;
    }

    if (data.type === "recomputeRoi") {
      if (!activeState) throw new Error("No active analysis available for ROI recomputation.");
      const roi = evaluateRois({
        width: activeState.width,
        height: activeState.height,
        validMask: activeState.validMask,
        validCount: activeState.validCount,
        maps: activeState.maps,
        roiMode: data.options?.roiMode ?? "auto",
        customTarget: data.options?.customTarget ?? null,
        customReference: data.options?.customReference ?? null,
      });
      const transfer = Array.from(new Set([
        roi.targetMask.buffer,
        roi.referenceMask.buffer,
      ]));
      self.postMessage({ type: "roiResult", id: data.id, roi }, transfer);
      return;
    }

    throw new Error(`Unknown worker task: ${data.type}`);
  } catch (error) {
    self.postMessage({
      type: "error",
      id: data.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
