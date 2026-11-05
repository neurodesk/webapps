// Tiles for the browser tests: the pinned example's manifest, and small synthetic mosaics with
// exact ground truth (test/synthetic.js) written as uint16 TIFF tiles.
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { writeTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { syntheticMosaic } from "../test/synthetic.js";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
export const example = examples[0];
export const reference = JSON.parse(await readFile(new URL("../validation/example-reference.json", import.meta.url), "utf8"));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const cache = new Map();
/** One example file, downloaded once and checked against its pinned SHA-256. */
export async function exampleFileBytes(file) {
  if (cache.has(file.url)) return cache.get(file.url);
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match examples.json`);
  cache.set(file.url, bytes);
  return bytes;
}

/**
 * A synthetic mosaic as Playwright file payloads: tiles tile_<row>_<column>.tif in row-by-row
 * order, their true positions, and the grid that approximates them.
 */
export function syntheticTiles({ columns = 2, rows = 2, shape = [160, 128], overlap = 0.2, jitter = 6, depth = 0, seed = 3 } = {}) {
  const mosaic = syntheticMosaic({ columns, rows, shape, overlap, jitter, depth, seed });
  const [width, height] = shape;
  const files = mosaic.tiles.map((tile, k) => {
    const data = Uint16Array.from(tile.data, (v) => Math.max(0, Math.min(65535, Math.round(v * 20))));
    const name = `tile_${Math.floor(k / columns) + 1}_${(k % columns) + 1}.tif`;
    return { name, mimeType: "image/tiff", buffer: Buffer.from(writeTiffStack({ width, height, data })) };
  });
  return { files, truth: mosaic.truth, grid: { columns, rows, overlap: overlap * 100 } };
}
