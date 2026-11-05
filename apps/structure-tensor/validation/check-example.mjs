// Holds src/tensor.js on the SHG example to the scipy reference in validation/reference.json.
//
//   node validation/check-example.mjs <skin12_shg_polarisation_sum.tif>
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { analyse } from "../src/tensor.js";
import { readTiff } from "../src/tiff.js";

const reference = JSON.parse(await readFile(new URL("./reference.json", import.meta.url), "utf8")).example;

/** Signed difference of two orientations on the 180° circle. */
export function angleDifference(a, b) {
  return ((((a - b) % 180) + 270) % 180) - 90;
}

/**
 * Compares maps of the example (Float32 or Float64 orientation, coherency and energy, x fastest)
 * with the reference and returns the largest differences. Float32 maps are compared at float32
 * precision.
 */
export function compareExample({ orientation, coherency, energy }) {
  const [nx] = reference.dims;
  let angle = 0;
  let coherence = 0;
  let power = 0;
  reference.points.forEach(([x, y], k) => {
    const i = x + nx * y;
    angle = Math.max(angle, Math.abs(angleDifference(orientation[i], reference.orientation[k])));
    coherence = Math.max(coherence, Math.abs(coherency[i] - reference.coherency[k]));
    power = Math.max(power, Math.abs(energy[i] - reference.energy[k]) / Math.max(1e-12, reference.energy[k]));
  });
  return { angle, coherence, power };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bytes = await readFile(process.argv[2]);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest !== reference.sha256) throw new Error(`${process.argv[2]} is not the reference example (${digest}).`);
  const image = await readTiff(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const started = performance.now();
  const result = analyse(image, reference.settings);
  const seconds = (performance.now() - started) / 1000;
  const differences = compareExample(result.maps);
  const histogram = Array.from(result.distributions.orientation.counts);
  const binsDiffering = histogram.filter((count, bin) => count !== reference.histogram[bin]).length;
  const report = {
    seconds: Number(seconds.toFixed(2)),
    dominantOrientationDifference: Math.abs(angleDifference(result.dominant.orientation, reference.dominant.orientation)),
    dominantCoherencyDifference: Math.abs(result.dominant.coherency - reference.dominant.coherency),
    counted: [result.distributions.orientation.total, reference.counted],
    binsDiffering,
    maxPointOrientationDifferenceDeg: differences.angle,
    maxPointCoherencyDifference: differences.coherence,
    maxPointEnergyRelativeDifference: differences.power,
  };
  console.log(JSON.stringify(report, null, 2));
  const pass = report.dominantOrientationDifference < 1e-9 && report.dominantCoherencyDifference < 1e-12
    && binsDiffering === 0 && differences.angle < 1e-9 && differences.coherence < 1e-12 && differences.power < 1e-10;
  if (!pass) process.exit(1);
}
