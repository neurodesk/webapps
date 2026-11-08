// An `examples` data root laid out as `neurodesk-compute fetch-example
// relion-tutorial` leaves it, with placeholder files under the tutorial's names.
// The simulated relion tool checks that files exist and never reads the movies.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeMrc } from "../../../test-utils/relion-simulator.mjs";

// The 24 movie numbers of the tutorial subset, as its SHA256SUMS lists them.
const NUMBERS = [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 35, 36, 37, 39, 40, 42, 43, 44, 45, 46, 47, 48, 49];

/** Write the placeholder tutorial under `root` and return the `examples` root's path. */
export function writeTutorialRoot(root) {
  const examples = join(root, "examples");
  const movies = join(examples, "relion-tutorial/Movies");
  mkdirSync(movies, { recursive: true });
  for (const number of NUMBERS) writeFileSync(join(movies, `20170629_000${number}_frameImage.tiff`), "placeholder movie");
  writeFileSync(join(movies, "gain.mrc"), writeMrc({ nx: 8, ny: 8, data: new Float32Array(64).fill(1) }));
  return examples;
}
