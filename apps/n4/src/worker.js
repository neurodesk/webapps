// The N4 worker: N4 is synchronous, so it runs here and the page stays responsive. The
// Emscripten module is staged in public/n4/ (scripts/copy-runtime.mjs) and imported by URL.
// In: { image, weight } (NIfTI bytes). Out: { corrected, bias } or { error }; log lines as { log }.
import { createN4 } from "@neurodesk/n4";

let enginePromise;

function engine() {
  enginePromise ??= import(/* @vite-ignore */ new URL("../n4/n4-bias.mjs", self.location.href).href)
    .then(({ default: createModule }) => createN4({ createModule, onLog: (line) => self.postMessage({ log: line }) }));
  return enginePromise;
}

self.onmessage = async ({ data: message }) => {
  try {
    const n4 = await engine();
    const { corrected, bias } = await n4.correct({ image: message.image, weight: message.weight });
    const out = { corrected: corrected.slice().buffer, bias: bias.slice().buffer };
    self.postMessage(out, [out.corrected, out.bias]);
  } catch (error) {
    self.postMessage({ error: error?.message ?? String(error) });
  }
};
