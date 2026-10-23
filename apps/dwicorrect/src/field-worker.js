// The field worker: the sdc package's PyHySCO port on the mean b0 of the series and of the
// reverse phase-encoding image. The page cancels a run by terminating it.
import { loadSdc } from "@neurodesk/sdc";
import wasmUrl from "@neurodesk/sdc/wasm?url";

const ready = loadSdc(fetch(wasmUrl));

self.onmessage = async ({ data: message }) => {
  try {
    const { pyhysco } = await ready;
    const out = pyhysco(message.image1, message.image2, message.dims, message.voxel, message.options);
    self.postMessage({ ok: true, field: out.field, iterations: out.iterations }, [out.field.buffer]);
  } catch (error) {
    self.postMessage({ ok: false, message: error?.message ?? String(error) });
  }
};
