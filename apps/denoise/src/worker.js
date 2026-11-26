// Module worker running self-supervised denoising off the main thread.
// Uses hardware WebGPU automatically for Zero-Shot Noise2Noise when available,
// with transparent fallback to CPU. One worker per run: terminating it cancels immediately.

import { denoiseVolumeAsync } from "@neurodesk/denoise/core";

self.onmessage = async ({ data }) => {
  try {
    if (data.type !== "denoise") {
      throw new Error(`Unknown worker request '${data.type}'.`);
    }
    const { image, dims, settings, runtime } = data;
    const result = await denoiseVolumeAsync(
      image,
      dims,
      settings,
      (fraction, stage) => {
        self.postMessage({ type: "progress", fraction, stage });
      },
      runtime,
    );
    self.postMessage(
      {
        type: "result",
        denoised: result.denoised,
        residual: result.residual,
        diagnostics: result.diagnostics,
        details: result.details,
      },
      [result.denoised.buffer, result.residual.buffer],
    );
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message ?? String(error) });
  }
};
