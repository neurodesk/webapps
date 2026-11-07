// Reading and measuring off the main thread. One worker serves one run; the page
// terminates it to cancel, so a long reconstruction stops at once.
//
// { op: "read", items: [{ id, text }], repair } -> per item { samples, issues, header, morphology, repair } or { error }
// { op: "measure", items: [{ id, morphology, repair }], step } -> per item an analysis; the first failure fails the run
// Progress is posted as { progress: fraction } after each item.
import { readSwc } from "./morph/swc.js";
import { analyse, buildMorphology } from "./morph/morphometrics.js";

function read({ id, text }, repair) {
  try {
    const { samples, issues, header } = readSwc(text, { repair });
    const morphology = buildMorphology(samples);
    if (!morphology.neurites.length) throw new Error("No neurites to measure.");
    return { samples, issues, header, morphology, repair };
  } catch (error) {
    return { error: `${id}: ${error.message}` };
  }
}

function measure({ id, morphology, repair }, step) {
  try {
    return analyse(morphology, step, { unknownZeroRadii: repair });
  } catch (error) {
    throw new Error(`${id}: ${error.message}`);
  }
}

self.onmessage = ({ data }) => {
  try {
    const results = [];
    for (const [k, item] of data.items.entries()) {
      results.push(data.op === "read" ? read(item, data.repair) : measure(item, data.step));
      self.postMessage({ progress: (k + 1) / data.items.length });
    }
    self.postMessage({ results });
  } catch (error) {
    self.postMessage({ error: error.message });
  }
};
