// The whole run, independent of the browser: stream the stack plane by plane into the atlas
// grid (and the cell detector), register to the atlas, and report cells per region. The worker
// and the Node validation test both call runPipeline.

import { createDetector } from './detect.js';
import { atlasOrderShape, createDownsampler, stackToGrid, downsampledShape } from './space.js';
import { registerToAtlas } from './registration.js';
import { assignCells, cellCsv, regionCsv, regionReport, regionVoxels, structureTable } from './regions.js';

export const ATLAS_RESOLUTION_UM = 50;
/** Largest display grid when the stack is not registered (voxels). */
export const DISPLAY_VOXELS = 24_000_000;
/** Largest registration grid: four times the atlas (264 × 160 × 228 voxels at 50 µm). */
export const REGISTRATION_VOXELS = 4 * 264 * 160 * 228;
/** Working memory a run may plan for, outside Greedy's own heap. */
export const MEMORY_BUDGET_BYTES = 3 * 2 ** 30;

const product = (values) => values.reduce((a, b) => a * b, 1);
const gib = (bytes) => `${(bytes / 2 ** 30).toFixed(1)} GB`;

/**
 * The resolution level a registration-only run reads: the coarsest OME-Zarr level whose voxels
 * are all at most the atlas resolution, so a whole-brain run does not decode full resolution.
 * `voxelSizeUm` is level 0's (the user's calibration); a level's voxels are that times the ratio
 * of its declared scale to level 0's, or of the shapes where a level declares no scale (odd
 * dimensions make the shape ratio smaller than the scale ratio).
 * Returns { level, shape, voxelSizeUm } (level 0 for TIFF stacks).
 */
export function chooseLevel(stack, voxelSizeUm) {
  let chosen = { level: 0, shape: stack.shape, voxelSizeUm };
  const top = stack.levels?.[0];
  const axes = ['z', 'y', 'x'];
  stack.levels?.forEach((level, index) => {
    const spacing = voxelSizeUm.map((v, k) => {
      const declared = level.voxelSizeUm?.[axes[k]];
      const base = top.voxelSizeUm?.[axes[k]];
      return declared > 0 && base > 0 ? (v * declared) / base : (v * top.shape[k]) / level.shape[k];
    });
    if (index > 0 && spacing.every((v) => v <= ATLAS_RESOLUTION_UM)) chosen = { level: index, shape: level.shape, voxelSizeUm: spacing };
  });
  return chosen;
}

/**
 * Bytes the run holds in JavaScript: the grid accumulator (float64) and its reoriented copy
 * (float32), the downsampler's row pass, and, when detecting, the ball filter's window of planes,
 * the per-plane filter buffers and the structure labels of two planes.
 */
export function workingBytes({ shape, gridShape, detect, ballDepth = 0 }) {
  const plane = shape[1] * shape[2];
  const grid = product(gridShape) * 12 + shape[1] * gridShape[2] * 8;
  const detection = detect ? plane * (4 * (ballDepth + 10) + 16) : 0;
  return grid + detection;
}

function checkSize({ shape, voxelSizeUm, gridShape, register, detect, ballDepth }) {
  if (register && product(gridShape) > REGISTRATION_VOXELS) {
    const mm = shape.map((n, i) => ((n * voxelSizeUm[i]) / 1000).toFixed(1)).join(' × ');
    throw new RangeError(`At this voxel size the stack is ${mm} mm (z × y × x), larger than a mouse brain (the atlas is 13.2 × 8 × 11.4 mm): check the voxel size, which is in µm.`);
  }
  const bytes = workingBytes({ shape, gridShape, detect, ballDepth });
  if (bytes > MEMORY_BUDGET_BYTES) {
    throw new RangeError(`This run needs about ${gib(bytes)} of working memory, more than the ${gib(MEMORY_BUDGET_BYTES)} this app plans for: crop the stack or choose a coarser level.`);
  }
}

/**
 * The grid the sample is shown and registered on: the atlas resolution when registering, else
 * the stack's own sampling, coarsened evenly until it holds at most DISPLAY_VOXELS.
 */
export function gridSpacing(shape, voxelSizeUm, register) {
  if (register) return [ATLAS_RESOLUTION_UM, ATLAS_RESOLUTION_UM, ATLAS_RESOLUTION_UM];
  const voxels = shape.reduce((a, b) => a * b, 1);
  const factor = Math.max(1, Math.cbrt(voxels / DISPLAY_VOXELS));
  return voxelSizeUm.map((v) => v * factor);
}

function check(signal) {
  signal?.throwIfAborted();
}

/**
 * stack: { shape: [z, y, x], dtype, readPlane(z, level?), levels? }; voxelSizeUm: [z, y, x];
 * orientation: e.g. "psl". loadAtlas(): { template, annotation (raw .nii bytes), structures (json),
 * shape }. greedy: the Greedy WebAssembly API (only when register).
 * cells: stack points [[x, y, z], ...] to map instead of detecting candidates (validation).
 * onProgress(fraction, message).
 * The result's spacingUm is the grid's, in grid (asr) order.
 */
export async function runPipeline({ stack, voxelSizeUm, orientation, register, detect, detectOptions, cells: injected = null, loadAtlas, greedy, onProgress = () => {}, onLog = () => {}, signal }) {
  const detecting = Boolean(detect) && !injected;
  if (!register && !detecting && !injected) throw new Error('Choose registration, cell detection or both.');
  const source = register && !detecting && !injected ? chooseLevel(stack, voxelSizeUm) : { level: 0, shape: stack.shape, voxelSizeUm };
  if (source.level) onLog(`Reading resolution level ${source.level}: ${source.shape.join(' × ')} at ${source.voxelSizeUm.map((v) => Number(v.toFixed(2))).join(' × ')} µm`);
  const shape = source.shape;
  const spacing = gridSpacing(shape, source.voxelSizeUm, register);
  const scale = source.voxelSizeUm.map((v, i) => v / spacing[i]);
  const targetStackOrder = downsampledShape(shape, scale, 1);
  const detector = detecting ? createDetector({ height: shape[1], width: shape[2], voxelSizesUm: voxelSizeUm, dtype: stack.dtype, options: detectOptions }) : null;
  checkSize({ shape, voxelSizeUm: source.voxelSizeUm, gridShape: targetStackOrder, register, detect: detecting, ballDepth: detector?.settings.ball.z });
  const downsampler = createDownsampler({ shape, voxelSizeUm: scale, orientation, resolutionUm: 1 });
  if (detector) {
    const s = detector.settings;
    onLog(`Cell detection: soma ${s.somaDiameter} px, ball ${s.ball.xy} × ${s.ball.xy} × ${s.ball.z} px, threshold mean + ${s.nSdsAboveMeanThresh} SD`);
  }
  const readShare = register ? 0.3 : 0.95;
  const started = Date.now();
  for (let z = 0; z < shape[0]; z++) {
    check(signal);
    const plane = await stack.readPlane(z, source.level);
    downsampler.push(z, plane);
    detector?.push(plane);
    onProgress((readShare * (z + 1)) / shape[0], `${detecting ? 'Filtering' : 'Reading'} plane ${z + 1} of ${shape[0]}`);
    if (detecting) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const grid = downsampler.finish();
  const spacingUm = atlasOrderShape(spacing, orientation);
  onLog(`Read ${shape[0]} planes in ${((Date.now() - started) / 1000).toFixed(1)} s; grid ${grid.shape.join(' × ')} at ${spacingUm.map((v) => Number(v.toFixed(2))).join(' × ')} µm`);
  const found = detector ? detector.finish() : null;
  if (found) onLog(`Detected ${found.cells.length} cell candidates (${found.artifacts.length} oversized structures left out)`);
  const cells = injected ?? found?.cells ?? null;
  // cellfinder reports (x, y, z); the grid takes stack indices (z, y, x).
  const gridPoints = cells?.map(([x, y, z]) => stackToGrid([z, y, x], shape, targetStackOrder, orientation));
  const result = { grid, spacingUm, cells, gridPoints, artifacts: found?.artifacts ?? null };
  if (!register) return result;

  check(signal);
  onProgress(readShare, 'Loading the Allen atlas');
  const atlas = await loadAtlas();
  check(signal);
  const table = structureTable(atlas.structures);
  const stages = { affine: [0.35, 'Affine registration'], deformable: [0.5, 'Deformable registration'], labels: [0.9, 'Placing atlas labels'], coordinates: [0.93, 'Mapping atlas coordinates'] };
  const registration = registerToAtlas({
    api: greedy,
    sample: grid.data,
    shape: grid.shape,
    atlas: { template: atlas.template, annotation: atlas.annotation, shape: table.shape },
    onStage: (stage) => {
      onProgress(...stages[stage]);
      onLog(`${stages[stage][1]} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
    },
  });
  check(signal);
  const voxels = regionVoxels(registration.labels, registration.coordinates, table);
  const annotation = atlas.annotationData;
  const assigned = cells ? assignCells(gridPoints, { coordinates: registration.coordinates, gridShape: grid.shape, annotation, table }) : null;
  const voxelVolumeMm3 = (ATLAS_RESOLUTION_UM / 1000) ** 3;
  const rows = regionReport({ voxels, cells: assigned, table, voxelVolumeMm3 });
  return {
    ...result,
    table,
    atlasTemplate: atlas.template,
    labels: registration.labels,
    coordinates: registration.coordinates,
    matrix: registration.matrix,
    assigned,
    rows,
    regionCsv: regionCsv(rows),
    cellCsv: cells ? cellCsv(cells, assigned, table) : null,
  };
}

/** cells.csv for a detection-only run: stack voxel indices and microns. */
export function candidateCsv(cells, voxelSizeUm) {
  const [vz, vy, vx] = voxelSizeUm;
  const lines = cells.map(([x, y, z]) => [x, y, z, (x * vx).toFixed(2), (y * vy).toFixed(2), (z * vz).toFixed(2)].join(','));
  return `x,y,z,x_um,y_um,z_um\n${lines.join('\n')}\n`;
}
