// Stitches the example in Node with the app's pipeline and compares it with Fiji's
// Grid/Collection stitching (validation/fiji/, run headless in Docker by run-fiji.sh).
// With --write it records the comparison and the app's exact outputs in
// validation/example-reference.json, which test/reference.test.js and the browser test check.
//
//   node validation/fiji-example.mjs <example dir> [--write]
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { readTiffStack } from '@neurodesk/webapp-components/file-io/tiff';
import { compareNames, parseTileConfiguration, positionsFromConfiguration } from '../src/core/tile-layout.js';
import { maxPositionDifference, planPairs, registerPairs, relativeToFirst } from '../src/core/pipeline.js';
import { optimisePositions } from '../src/core/global.js';
import { fuseTiles, toSampleType } from '../src/core/fusion.js';
import { fusedTiff, registeredConfiguration } from '../src/outputs.js';

const [dir, flag] = process.argv.slice(2);
const here = new URL('./', import.meta.url);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const names = (await readdir(dir)).filter((name) => name.endsWith('.tif')).sort(compareNames);
const tiles = [];
for (const name of names) {
  const bytes = await readFile(`${dir}/${name}`);
  const stack = await readTiffStack(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  tiles.push({ shape: [stack.width, stack.height], data: stack.data, dtype: stack.dtype });
}
const approximate = positionsFromConfiguration(parseTileConfiguration(await readFile(`${dir}/TileConfiguration.txt`, 'utf8')), names, 2);
const started = performance.now();
const links = registerPairs(tiles, planPairs(tiles.map((t) => t.shape), approximate));
const result = optimisePositions(approximate, links);
const seconds = (performance.now() - started) / 1000;
const fused = fuseTiles(tiles, result.positions);
const data = toSampleType(fused.data, tiles[0].dtype);
const tiff = fusedTiff({ data, shape: fused.shape, pixelSize: null });
const configuration = registeredConfiguration(names, result.positions);

const fijiPositions = positionsFromConfiguration(parseTileConfiguration(await readFile(new URL('fiji/TileConfiguration.registered.txt', here), 'utf8')), names, 2);
const fijiPairs = (await readFile(new URL('fiji/pairs.tsv', here), 'utf8')).trim().split('\n').map((line) => {
  const [a, b, dx, dy, r] = line.split('\t');
  return { a, b, offset: [Number(dx), Number(dy)], r: Number(r) };
});
const pairDifferences = fijiPairs.map((pair) => {
  const link = result.links.find((l) => names[l.i] === pair.a && names[l.j] === pair.b);
  return { a: pair.a, b: pair.b, fiji: pair.offset, app: link.offset.map((v) => Number(v.toFixed(4))), difference: Number(Math.hypot(...link.offset.map((v, d) => v - pair.offset[d])).toFixed(4)), fijiR: pair.r, appR: Number(link.r.toFixed(4)) };
});
const appRelative = relativeToFirst(result.positions);
const fijiRelative = relativeToFirst(fijiPositions);
const report = {
  example: 'NIST MIST Small_Phase_Test_Dataset, rows 1-4 x columns 1-4 (apps/stitching/examples.json)',
  fiji: {
    image: 'fiji/fiji@sha256:6ca1105db5b8f4234baab107f7b833ba0f5da64770ef48dddabb954990d68120',
    plugin: 'Stitching_-3.1.8.jar, Grid/Collection stitching',
    macro: 'validation/fiji/grid-collection-stitching.ijm',
  },
  pairs: { count: pairDifferences.length, largestDifference: Math.max(...pairDifferences.map((p) => p.difference)), list: pairDifferences },
  positions: {
    largestDifference: Number(maxPositionDifference(result.positions, fijiPositions).toFixed(4)),
    tiles: names.map((name, k) => ({ name, fiji: fijiRelative[k].map((v) => Number(v.toFixed(4))), app: appRelative[k].map((v) => Number(v.toFixed(4))) })),
  },
  outputs: {
    registeredConfigurationSha256: sha256(configuration),
    fusedShape: fused.shape,
    fusedTiffSha256: sha256(tiff),
    fusedTiffBytes: tiff.length,
  },
};
console.log(JSON.stringify({ seconds: Number(seconds.toFixed(1)), pairs: report.pairs.count, largestPairDifference: report.pairs.largestDifference, largestPositionDifference: report.positions.largestDifference, ...report.outputs }, null, 1));
if (flag === '--write') await writeFile(new URL('example-reference.json', here), `${JSON.stringify(report, null, 2)}\n`);
if (report.positions.largestDifference >= 1) process.exitCode = 1;
