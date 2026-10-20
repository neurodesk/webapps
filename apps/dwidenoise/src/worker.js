// One Patch2Self worker: loads the WebAssembly once, then handles one voxel chunk per message.
// In: { id, type: "gram" | "apply", data, count, groups, coefficients? }.
// Out: { id, grams } for "gram", { id, data } for "apply", or { id, error }.
import { loadDwidenoise } from "@neurodesk/dwidenoise";
import wasmUrl from "@neurodesk/dwidenoise/wasm?url";

const ready = loadDwidenoise(fetch(wasmUrl));

self.onmessage = async ({ data: message }) => {
  try {
    const p2s = await ready;
    const buffer = p2s.allocate(message.data.length);
    try {
      buffer.view().set(message.data);
      if (message.type === "gram") {
        const grams = message.groups.map((group) =>
          p2s.accumulate(buffer, message.count, group, new Float64Array(p2s.gramLength(group.length))),
        );
        self.postMessage({ id: message.id, grams }, grams.map((gram) => gram.buffer));
      } else {
        message.groups.forEach((group, g) => p2s.apply(buffer, message.count, group, message.coefficients[g]));
        const out = buffer.view().slice();
        self.postMessage({ id: message.id, data: out }, [out.buffer]);
      }
    } finally {
      buffer.free();
    }
  } catch (error) {
    self.postMessage({ id: message.id, error: error?.message ?? String(error) });
  }
};
