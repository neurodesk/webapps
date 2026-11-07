// The app's registration of the example brain against brainreg's own outputs on the same planes
// (pinned in brainreg-reference.json, checked against their sha256): whole-brain Dice, the
// distance between the two sample-to-atlas maps, and where both put given sample points.
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { sampleTrilinear } from '../src/registration.js';
import { hemisphereOf } from '../src/regions.js';
import { fetchPinned } from './run-example.mjs';

const reference = JSON.parse(await readFile(new URL('./brainreg-reference.json', import.meta.url), 'utf8'));

/** The Allen major divisions brainreg-reference.json reports Dice for, by structure id. */
export const DIVISIONS = Object.freeze({
  Isocortex: 315, OLF: 698, HPF: 1089, CTXsp: 703, STR: 477, PAL: 803, TH: 549, HY: 1097,
  MB: 313, P: 771, MY: 354, CB: 512, 'fiber tracts': 1009, VS: 73,
});
const DIVISION_IDS = new Set(Object.values(DIVISIONS));

/** brainreg's outputs on the sample grid: { registeredAtlas: Uint32Array (Allen ids), deformation: [Float32Array x3] (atlas voxels) }. */
export async function loadBrainreg() {
  const files = Object.fromEntries(reference.brainreg.outputs.files.map((entry) => [entry.id, entry]));
  const read = async (id, Type) => readNiftiImageData(gunzipSync(await fetchPinned(files[id])), Type).data;
  const registeredAtlas = await read('registered_atlas', Uint32Array);
  const resolutionMm = 0.05;
  const deformation = [];
  for (const axis of [0, 1, 2]) {
    const mm = await read(`deformation_field_${axis}`, Float32Array);
    deformation.push(Float32Array.from(mm, (v) => v / resolutionMm));
  }
  return { registeredAtlas, deformation, shape: reference.app.grid };
}

/** The major division (structure id) an Allen structure belongs to, or 0. */
export function divisionOf(id, table) {
  const structure = table.byId.get(id);
  return structure?.path?.find((ancestor) => DIVISION_IDS.has(ancestor)) ?? 0;
}

/** Whole-brain Dice of the app's labels against brainreg's registered atlas. */
export function wholeBrainDice(labels, registeredAtlas) {
  let both = 0;
  let ours = 0;
  let theirs = 0;
  for (let i = 0; i < labels.length; i++) {
    const a = labels[i] > 0;
    const b = registeredAtlas[i] > 0;
    if (a) ours++;
    if (b) theirs++;
    if (a && b) both++;
  }
  return (2 * both) / (ours + theirs);
}

const median = (values) => {
  const sorted = Float64Array.from(values).sort();
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Median distance (µm) between the app's and brainreg's atlas coordinate of every voxel inside brainreg's brain. */
export function medianMapDistanceUm(coordinates, brainreg, resolutionUm = 50) {
  const distances = [];
  for (let i = 0; i < brainreg.registeredAtlas.length; i++) {
    if (!brainreg.registeredAtlas[i]) continue;
    let d2 = 0;
    for (let axis = 0; axis < 3; axis++) d2 += (coordinates[axis][i] - brainreg.deformation[axis][i]) ** 2;
    distances.push(Math.sqrt(d2) * resolutionUm);
  }
  return median(distances);
}

/**
 * For each mapped point (the app's assignCells rows, with the grid position they were sampled
 * at), brainreg's atlas coordinate at that grid position and how the two compare: distance in
 * atlas voxels, and whether hemisphere and major division agree. `annotation` holds the atlas
 * structure indices, as assignCells reads them.
 */
export function comparePoints(assigned, brainreg, { annotation, table }) {
  const [A, S] = table.shape;
  return assigned.map((row) => {
    const theirs = [0, 1, 2].map((axis) => sampleTrilinear(brainreg.deformation[axis], brainreg.shape, row.grid));
    if (!row.atlas || theirs.includes(null)) return { distance: Infinity, hemisphere: false, division: false };
    const distance = Math.hypot(...row.atlas.map((v, axis) => v - theirs[axis]));
    const [a, s, r] = theirs.map(Math.round);
    const theirIndex = annotation[a + A * (s + S * r)] ?? 0;
    const division = (index) => (index ? divisionOf(table.byIndex.get(index).id, table) : 0);
    return {
      distance,
      hemisphere: row.hemisphere === (theirIndex ? hemisphereOf(theirs[2], table) : null),
      division: division(row.index) === division(theirIndex),
      theirDivision: division(theirIndex),
    };
  });
}
