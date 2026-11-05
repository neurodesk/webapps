// Test movies for the browser tests: the pinned example and a small synthetic movie.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { imagejDescription, writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
export const example = examples[0];
export const exampleFile = example.files[0];

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let cached = null;
/** The example movie, downloaded once and checked against its pinned SHA-256. */
export async function exampleBytes() {
  if (cached) return cached;
  const response = await fetch(exampleFile.url);
  if (!response.ok) throw new Error(`${exampleFile.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== exampleFile.sha256) throw new Error(`${exampleFile.name}: SHA-256 does not match examples.json`);
  cached = bytes;
  return bytes;
}

/**
 * A 64 × 48 uint16 movie of `frames` frames at 10 Hz: four Gaussian cells (σ 2 px) with
 * AR(1) calcium (g 0.9) driven by seeded spikes, on a 200-count background with seeded noise.
 * Cell centres are at (y, x) = (12, 14), (14, 46), (34, 20) and (36, 50).
 */
export function syntheticMovie(frames = 120, { frameRate = 10 } = {}) {
  const width = 64;
  const height = 48;
  let state = 2024;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const cells = [[12, 14], [14, 46], [34, 20], [36, 50]];
  const calcium = cells.map(() => 0);
  const data = new Uint16Array(frames * width * height);
  for (let f = 0; f < frames; f++) {
    cells.forEach((_, k) => {
      calcium[k] = 0.9 * calcium[k] + (random() < 0.06 ? 1 + random() : 0);
    });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let value = 200 + (random() - 0.5) * 40;
        cells.forEach(([cy, cx], k) => {
          const weight = Math.exp(-((y - cy) ** 2 + (x - cx) ** 2) / 8);
          value += weight * (150 + 400 * calcium[k]);
        });
        data[f * width * height + y * width + x] = Math.round(value);
      }
    }
  }
  const description = imagejDescription({ frames, frameInterval: 1 / frameRate });
  return Buffer.from(writeTiffStack({ width, height, data, description }));
}

export const tiff = (name, buffer) => ({ name, mimeType: "image/tiff", buffer });
