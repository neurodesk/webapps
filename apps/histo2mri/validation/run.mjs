// Records the validation numbers in validation/results.json:
//   node validation/run.mjs [--data <dir holding the example files>]
// 1. Synthetic: the example MRI's slice 50 deformed by a known affine and smooth warp and
//    re-coloured as H&E (validation/synthetic.js), registered back; landmark error on a grid.
// 2. Example: the example section registered to its MRI; error at the manual landmarks of
//    validation/example-landmarks.json.
// Both run the app's pipeline with Greedy's committed single-threaded WebAssembly, the build
// the browser worker runs. Without --data the example files are downloaded from their pinned
// URLs and checked against examples.json.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { readTiffImage } from '@neurodesk/webapp-components/file-io/tiff';
import { registerSection, sectionPixelAt } from '../src/core/register.js';
import { samplePlane, slicePlane } from '../src/core/plane.js';
import { apply } from '../src/core/matrix.js';
import { landmarkErrors, summarise, syntheticLandmarks, syntheticSection, syntheticTransform } from './synthetic.js';
import { nodeGreedy } from '../test/helpers.js';

const here = new URL('./', import.meta.url);
const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));
const example = examples[0];
const dataArgument = process.argv.indexOf('--data');

async function exampleFile(role) {
  const file = example.files.find((entry) => entry.role === role);
  let bytes;
  if (dataArgument > 0) {
    bytes = await readFile(join(process.argv[dataArgument + 1], file.name));
  } else {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (sha256 !== file.sha256) throw new Error(`${file.name}: sha256 ${sha256}, expected ${file.sha256}`);
  return bytes;
}

function arrayBuffer(bytes) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

const nifti = parseNiftiVolume(arrayBuffer(gunzipSync(await exampleFile('mri'))));
const volume = { dims: nifti.dims, affine: Array.from(nifti.affine, (row) => Array.from(row)), data: nifti.imageData };
const section = await readTiffImage(arrayBuffer(await exampleFile('section')));
const greedy = await nodeGreedy();
const { axis, index } = example.parameters;
const round = (value, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;

// 1. Synthetic experiment on the example's real MRI slice.
const plane = slicePlane(volume, { axis, index });
const slice = samplePlane(volume, plane);
const synthVolume = { dims: [plane.nu, plane.nv, 5], affine: [[plane.spacing, 0, 0, 0], [0, plane.spacing, 0, 0], [0, 0, plane.spacing, 0], [0, 0, 0, 1]], data: new Float32Array(plane.nu * plane.nv * 5) };
for (let k = 0; k < 5; k++) synthVolume.data.set(slice, k * slice.length);
const synthPlane = slicePlane(synthVolume, { axis: 2, index: 2 });
const transform = syntheticTransform(synthPlane);
const synthSection = syntheticSection(slice, synthPlane, transform);
const synthetic = {};
for (const deformable of [false, true]) {
  const result = await registerSection({ volume: synthVolume, section: synthSection, plane: { axis: 2, index: 2 }, options: { refinePlane: false, deformable }, greedy });
  const summary = summarise(landmarkErrors(result, transform, syntheticLandmarks(synthPlane, slice, 6)));
  synthetic[deformable ? 'affineAndDeformable' : 'affineOnly'] = { ...Object.fromEntries(Object.entries(summary).map(([key, value]) => [key, round(value)])), nmi: Object.fromEntries(Object.entries(result.nmi).map(([key, value]) => [key, round(value, 4)])) };
  console.log(deformable ? 'synthetic, affine + deformable' : 'synthetic, affine only', synthetic[deformable ? 'affineAndDeformable' : 'affineOnly']);
}

// 2. The example section and its manual landmarks.
const landmarks = JSON.parse(await readFile(new URL('example-landmarks.json', here), 'utf8')).landmarks;
const result = await registerSection({ volume, section, plane: { axis, index }, greedy });
const voxelMm = Math.cbrt(Math.abs(volume.affine[0][0] * volume.affine[1][1] * volume.affine[2][2] + volume.affine[0][1] * volume.affine[1][2] * volume.affine[2][0] + volume.affine[0][2] * volume.affine[1][0] * volume.affine[2][1] - volume.affine[0][2] * volume.affine[1][1] * volume.affine[2][0] - volume.affine[0][0] * volume.affine[1][2] * volume.affine[2][1] - volume.affine[0][1] * volume.affine[1][0] * volume.affine[2][2]));
const perLandmark = landmarks.map((landmark) => {
  const mapped = sectionPixelAt(result, apply(volume.affine, landmark.mriVoxel));
  const mm = Math.hypot(mapped.x - landmark.sectionPixel[0], mapped.y - landmark.sectionPixel[1]) * result.fullSpacing;
  return { id: landmark.id, confidence: landmark.confidence, errorMm: round(mm, 2), errorVoxels: round(mm / voxelMm, 2), distanceFromPlaneMm: round(mapped.distance, 2) };
});
const errors = perLandmark.map((entry) => entry.errorMm);
const exampleResult = {
  plane: { offsetMm: round(result.plane.offset), tiltDegrees: result.plane.tilt },
  orientation: result.orientation,
  sectionPixelSizeMm: round(result.fullSpacing, 4),
  nmi: Object.fromEntries(Object.entries(result.nmi).map(([key, value]) => [key, round(value, 4)])),
  landmarks: perLandmark,
  meanErrorMm: round(errors.reduce((sum, value) => sum + value, 0) / errors.length, 2),
  meanErrorVoxels: round(errors.reduce((sum, value) => sum + value, 0) / errors.length / voxelMm, 2),
};
console.log('example', exampleResult);
await mkdir(here, { recursive: true });
await writeFile(new URL('results.json', here), `${JSON.stringify({ greedy: '@neurodesk/greedy wasm-single', synthetic, example: exampleResult }, null, 2)}\n`);
