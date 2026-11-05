// The whole run, independent of the browser: stream the stack plane by plane into the atlas
// grid (and the cell detector), register to the atlas, and report cells per region. The worker
// and the Node validation test both call runPipeline.

import { createDetector } from './detect.js';
import { createDownsampler, stackToGrid, downsampledShape } from './space.js';
import { registerToAtlas } from './registration.js';
import { assignCells, cellCsv, regionCsv, regionReport, regionVoxels, structureTable } from './regions.js';

export const ATLAS_RESOLUTION_UM = 50;
/** Largest display grid when the stack is not registered (voxels). */
export const DISPLAY_VOXELS = 24_000_000;

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
 * stack: { shape: [z, y, x], readPlane(z) }; voxelSizeUm: [z, y, x]; orientation: e.g. "psl".
 * loadAtlas(): { template, annotation (raw .nii bytes), structures (json), shape }.
 * greedy: the Greedy WebAssembly API (only when register).
 * onProgress(fraction, message).
 */
export async function runPipeline({ stack, voxelSizeUm, orientation, register, detect, detectOptions, loadAtlas, greedy, onProgress = () => {}, onLog = () => {}, signal }) {
  if (!register && !detect) throw new Error('Choose registration, cell detection or both.');
  const shape = stack.shape;
  const spacing = gridSpacing(shape, voxelSizeUm, register);
  const targetStackOrder = downsampledShape(shape, voxelSizeUm.map((v, i) => v / spacing[i]), 1);
  const downsampler = createDownsampler({ shape, voxelSizeUm: voxelSizeUm.map((v, i) => v / spacing[i]), orientation, resolutionUm: 1 });
  const detector = detect ? createDetector({ height: shape[1], width: shape[2], voxelSizesUm: voxelSizeUm, options: detectOptions }) : null;
  if (detector) {
    const s = detector.settings;
    onLog(`Cell detection: soma ${s.somaDiameter} px, ball ${s.ball.xy} × ${s.ball.xy} × ${s.ball.z} px, threshold mean + ${s.nSdsAboveMeanThresh} SD`);
  }
  const readShare = register ? 0.3 : 0.95;
  const started = Date.now();
  for (let z = 0; z < shape[0]; z++) {
    check(signal);
    const plane = await stack.readPlane(z);
    downsampler.push(z, plane);
    detector?.push(plane);
    onProgress((readShare * (z + 1)) / shape[0], `${detect ? 'Filtering' : 'Reading'} plane ${z + 1} of ${shape[0]}`);
    if (detect) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const grid = downsampler.finish();
  onLog(`Read ${shape[0]} planes in ${((Date.now() - started) / 1000).toFixed(1)} s; grid ${grid.shape.join(' × ')} at ${spacing.map((v) => Number(v.toFixed(2))).join(' × ')} µm`);
  const found = detector ? detector.finish() : null;
  if (found) onLog(`Detected ${found.cells.length} cell candidates (${found.artifacts.length} oversized structures left out)`);
  const cells = found?.cells ?? null;
  // cellfinder reports (x, y, z); the grid takes stack indices (z, y, x).
  const gridPoints = cells?.map(([x, y, z]) => stackToGrid([z, y, x], shape, targetStackOrder, orientation));
  const result = { grid, spacingUm: spacing, cells, gridPoints, artifacts: found?.artifacts ?? null };
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
