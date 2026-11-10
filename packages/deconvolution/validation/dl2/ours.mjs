// The PSF for phantom.py, then RL and RL-TV with the committed module.
import { readFileSync, writeFileSync } from "node:fs";
import { loadDeconvolution } from "../../src/node.js";

const [, , mode, work] = process.argv;
const { gibsonLanniPsf, Deconvolver } = loadDeconvolution();
const read = (name) => {
  const bytes = readFileSync(`${work}/${name}`);
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / 8).slice();
};

if (mode === "psf") {
  writeFileSync(`${work}/psf.f64`, gibsonLanniPsf(1.4, 1.518, 1.518, 0.52, 0, 0.1, 0.2, 15, 13, 0));
} else {
  const psf = read("psf.f64");
  const sum = psf.reduce((a, b) => a + b, 0);
  const image = read("image.f64");
  for (const [name, iterations, weight] of JSON.parse(readFileSync(new URL("./runs.json", import.meta.url), "utf8"))) {
    const deconvolver = new Deconvolver(image, Uint32Array.of(36, 56, 56), psf.map((v) => v / sum), Uint32Array.of(13, 15, 15), weight);
    deconvolver.iterate(iterations);
    writeFileSync(`${work}/ours_${name}.f64`, deconvolver.estimate());
    deconvolver.free();
  }
}
