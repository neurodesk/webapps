// Module worker running self-supervised denoising off the main thread.
// One worker per run: terminating it cancels the run immediately and frees its buffers.

import { denoiseVolume } from "./core/denoise.js";

self.onmessage = ({ data }) => {
  try {
    if (data.type !== "denoise") {
      throw new Error(`Unknown worker request '${data.type}'.`);
    }
    const { image, dims, settings } = data;
    const result = denoiseVolume(image, dims, settings, (fraction, stage) => {
      self.postMessage({ type: "progress", fraction, stage });
    });
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
