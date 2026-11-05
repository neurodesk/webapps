// Recovers the synthetic mosaic written by synthetic_real.py and compares every tile's position
// with the truth (positions taken relative to the first tile).
//
//   python -I validation/synthetic_real.py <example tile> <dir>
//   node validation/synthetic-real.mjs <dir> [--write validation/synthetic-real.json]
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { readTiffStack } from '@neurodesk/webapp-components/file-io/tiff';
import { compareNames, parseTileConfiguration, positionsFromConfiguration } from '../src/core/tile-layout.js';
import { relativeToFirst, stitch } from '../src/core/pipeline.js';

const [dir, flag, out] = process.argv.slice(2);
const names = (await readdir(dir)).filter((name) => name.endsWith('.tif')).sort(compareNames);
const tiles = [];
for (const name of names) {
  const bytes = await readFile(`${dir}/${name}`);
  const stack = await readTiffStack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  tiles.push({ shape: [stack.width, stack.height], data: stack.data });
}
const approximate = positionsFromConfiguration(parseTileConfiguration(await readFile(`${dir}/TileConfiguration.txt`, 'utf8')), names, 2);
const truth = JSON.parse(await readFile(`${dir}/truth.json`, 'utf8'));
const result = stitch(tiles, approximate);
const found = relativeToFirst(result.positions);
const expected = relativeToFirst(names.map((name) => truth[name]));
const errors = names.map((name, k) => ({ tile: name, truth: expected[k], found: found[k], error: Math.hypot(...found[k].map((v, d) => v - expected[k][d])) }));
const layoutError = Math.max(...relativeToFirst(approximate).map((p, k) => Math.hypot(...p.map((v, d) => v - expected[k][d]))));
const report = {
  description: 'Synthetic 3 x 3 mosaic cut from one real NIST MIST tile (img_r002_c002.tif of the example) with known sub-pixel positions; see synthetic_real.py.',
  tiles: names.length,
  links: result.links.length,
  linksUsed: result.links.filter((link) => link.status === 'used').length,
  largestLayoutError: Number(layoutError.toFixed(3)),
  largestError: Number(Math.max(...errors.map((e) => e.error)).toFixed(4)),
  meanError: Number((errors.reduce((sum, e) => sum + e.error, 0) / errors.length).toFixed(4)),
  errors: errors.map((e) => ({ ...e, truth: e.truth.map((v) => Number(v.toFixed(4))), found: e.found.map((v) => Number(v.toFixed(4))), error: Number(e.error.toFixed(4)) })),
};
console.log(JSON.stringify({ largestLayoutError: report.largestLayoutError, largestError: report.largestError, meanError: report.meanError, linksUsed: report.linksUsed, links: report.links }));
if (flag === '--write') await writeFile(out, `${JSON.stringify(report, null, 2)}\n`);
if (report.largestError >= 0.5) process.exitCode = 1;
