// Records the validation numbers in validation/results.json:
//   node validation/run.mjs [--data <dir holding the example files>]
// 1. Synthetic: the example MRI's slice 50 deformed by a known affine and smooth warp and
//    re-coloured as H&E (validation/synthetic.js), registered back; landmark error on a grid.
// 2. Example: the example section registered to its MRI; error at the manual landmarks of
//    validation/example-landmarks.json.
// Each records the landmark error after every stage (start, rigid, affine, final; register.js
// `registrationStages`) in mm and MRI voxels: the synthetic case with and without the warp, the
// example with the default settings and with the plane search, the warp or both turned off.
// Both run the app's pipeline with Greedy's committed single-threaded WebAssembly, the build
// the browser worker runs. Without --data the example files are downloaded from their pinned
// URLs and checked against examples.json.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { parseNiftiVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { readTiffImage } from '@neurodesk/webapp-components/file-io/tiff';
import { registerSection, registrationStages, sectionPixelAt } from '../src/core/register.js';
import { samplePlane, slicePlane } from '../src/core/plane.js';
import { apply } from '../src/core/matrix.js';
import { mriVolume } from '../src/core/nifti.js';
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

const volume = mriVolume(parseNiftiVolume(arrayBuffer(gunzipSync(await exampleFile('mri')))));
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
const synthLandmarks = syntheticLandmarks(synthPlane, slice, 6);
const roundAll = (object, digits) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, round(value, digits)]));
const synthetic = { voxelMm: round(synthPlane.spacing, 4) };
for (const deformable of [false, true]) {
  const result = await registerSection({ volume: synthVolume, section: synthSection, plane: { axis: 2, index: 2 }, options: { refinePlane: false, deformable }, greedy });
  const stages = Object.fromEntries(Object.entries(registrationStages(result)).map(([stage, state]) => [stage, roundAll(summarise(landmarkErrors(state, transform, synthLandmarks)), 3)]));
  const key = deformable ? 'affineAndDeformable' : 'affineOnly';
  synthetic[key] = { ...stages.final, stages, nmi: roundAll(result.nmi, 4) };
  console.log(`synthetic, ${key}`, synthetic[key]);
}

// 2. The example section and its manual landmarks, in each configuration.
const landmarks = JSON.parse(await readFile(new URL('example-landmarks.json', here), 'utf8')).landmarks;
const voxelMm = Math.cbrt(Math.abs(volume.affine[0][0] * volume.affine[1][1] * volume.affine[2][2] + volume.affine[0][1] * volume.affine[1][2] * volume.affine[2][0] + volume.affine[0][2] * volume.affine[1][0] * volume.affine[2][1] - volume.affine[0][2] * volume.affine[1][1] * volume.affine[2][0] - volume.affine[0][0] * volume.affine[1][2] * volume.affine[2][1] - volume.affine[0][1] * volume.affine[1][0] * volume.affine[2][2]));
const perLandmark = (state) => landmarks.map((landmark) => {
  const mapped = sectionPixelAt(state, apply(volume.affine, landmark.mriVoxel));
  const mm = Math.hypot(mapped.x - landmark.sectionPixel[0], mapped.y - landmark.sectionPixel[1]) * state.fullSpacing;
  return { id: landmark.id, confidence: landmark.confidence, errorMm: round(mm, 2), errorVoxels: round(mm / voxelMm, 2), distanceFromPlaneMm: round(mapped.distance, 2) };
});
const meanError = (entries) => {
  const mm = entries.reduce((sum, entry) => sum + entry.errorMm, 0) / entries.length;
  return { meanErrorMm: round(mm, 2), meanErrorVoxels: round(mm / voxelMm, 2) };
};
const CONFIGURATIONS = {
  default: {},
  noPlaneSearch: { refinePlane: false },
  noWarp: { deformable: false },
  linearOnly: { refinePlane: false, deformable: false },
};
const configurations = {};
let result = null;
for (const [name, options] of Object.entries(CONFIGURATIONS)) {
  const run = await registerSection({ volume, section, plane: { axis, index }, options, greedy });
  result ??= run;
  configurations[name] = {
    options,
    warpKept: Boolean(run.warp),
    plane: { offsetMm: round(run.plane.offset), tiltDegrees: run.plane.tilt },
    nmi: roundAll(run.nmi, 4),
    stages: Object.fromEntries(Object.entries(registrationStages(run)).map(([stage, state]) => [stage, meanError(perLandmark(state))])),
  };
  console.log(`example, ${name}`, configurations[name].stages);
}
const landmarkErrorsMm = perLandmark(result);
const exampleResult = {
  voxelMm: round(voxelMm, 4),
  plane: { offsetMm: round(result.plane.offset), tiltDegrees: result.plane.tilt },
  orientation: result.orientation,
  sectionPixelSizeMm: round(result.fullSpacing, 4),
  nmi: roundAll(result.nmi, 4),
  landmarks: landmarkErrorsMm,
  ...meanError(landmarkErrorsMm),
  configurations,
};
console.log('example', exampleResult);
await mkdir(here, { recursive: true });
await writeFile(new URL('results.json', here), `${JSON.stringify({ greedy: '@neurodesk/greedy wasm-single', synthetic, example: exampleResult }, null, 2)}\n`);
