// The files a run hands to the page: NIfTI volumes on the grid the run used and the CSV tables,
// with the summary the page reports. The worker posts what resultFiles returns.
import { createNiftiFromData } from '@neurodesk/webapp-components/file-io/nifti';
import { candidateCsv } from './pipeline.js';
import { gridHeader, gridNifti } from './registration.js';

// A label volume marking each candidate with a ball about 10 µm across (at least one voxel), so
// candidates stay visible on fine and coarse grids. `spacingUm` is in grid order.
export function candidateMarks(points, shape, spacingUm) {
  const [A, S, R] = shape;
  const radius = spacingUm.map((v) => Math.max(0, Math.round(5 / v)));
  const marks = new Uint8Array(A * S * R);
  for (const point of points) {
    const [a, s, r] = point.map(Math.round);
    for (let da = -radius[0]; da <= radius[0]; da++) {
      for (let ds = -radius[1]; ds <= radius[1]; ds++) {
        for (let dr = -radius[2]; dr <= radius[2]; dr++) {
          const d = (radius[0] ? (da / radius[0]) ** 2 : 0) + (radius[1] ? (ds / radius[1]) ** 2 : 0) + (radius[2] ? (dr / radius[2]) ** 2 : 0);
          const [x, y, z] = [a + da, s + ds, r + dr];
          if (d <= 1 && x >= 0 && y >= 0 && z >= 0 && x < A && y < S && z < R) marks[x + A * (y + S * z)] = 1;
        }
      }
    }
  }
  return marks;
}

// A display window from the 1st to the 99.5th percentile of the voxels (sampled), so a few
// bright candidates do not leave the tissue black.
export function displayWindow(data) {
  const step = Math.max(1, Math.floor(data.length / 200000));
  const values = [];
  for (let i = 0; i < data.length; i += step) values.push(data[i]);
  values.sort((a, b) => a - b);
  const at = (q) => values[Math.min(values.length - 1, Math.floor(q * values.length))];
  const calMin = at(0.01);
  const calMax = at(0.995);
  return calMax > calMin ? { calMin, calMax } : {};
}

// NiiVue's label colormap for the indices present: Allen colours and acronyms.
export function labelColormap(table, labels) {
  const present = new Set(labels);
  present.delete(0);
  const indices = [...present].sort((a, b) => a - b);
  const rows = indices.map((index) => table.byIndex.get(index));
  return {
    R: [0, ...rows.map((s) => s.rgb[0])],
    G: [0, ...rows.map((s) => s.rgb[1])],
    B: [0, ...rows.map((s) => s.rgb[2])],
    A: [0, ...rows.map(() => 255)],
    I: [0, ...indices],
    labels: ['', ...rows.map((s) => `${s.acronym} · ${s.name}`)],
  };
}

/**
 * The page's result message for a runPipeline result: { gridShape, spacingUm, candidateCount,
 * files: { sample, labels?, registeredAtlas?, regions?, candidates?, marks? } (raw bytes), ... }.
 * `voxelSizeUm` is the stack's, [z, y, x].
 */
export function resultFiles(result, { register, voxelSizeUm }) {
  const { grid } = result;
  const encoder = new TextEncoder();
  const out = { gridShape: grid.shape, spacingUm: result.spacingUm, candidateCount: result.cells?.length ?? null };
  const files = {};
  if (register) {
    const atlasHeader = result.atlasTemplate;
    files.sample = gridNifti(grid.data, grid.shape, atlasHeader, displayWindow(grid.data));
    files.labels = gridNifti(result.labels, grid.shape, atlasHeader);
    const ids = new Uint32Array(result.labels.length);
    for (let i = 0; i < ids.length; i++) ids[i] = result.labels[i] ? result.table.byIndex.get(result.labels[i]).id : 0;
    files.registeredAtlas = gridNifti(ids, grid.shape, atlasHeader);
    files.regions = encoder.encode(result.regionCsv);
    out.labelColormap = labelColormap(result.table, result.labels);
    out.regionRows = result.rows.length;
    out.matrix = result.matrix;
    out.assignedCandidates = result.assigned ? result.assigned.filter((cell) => cell.index).length : null;
    if (result.cells) {
      files.candidates = encoder.encode(result.cellCsv);
      files.marks = gridNifti(candidateMarks(result.gridPoints, grid.shape, result.spacingUm), grid.shape, atlasHeader);
    }
  } else {
    const header = gridHeader(grid.shape, result.spacingUm);
    const toNifti = (data, options = { range: 'auto' }) => new Uint8Array(createNiftiFromData(data, header, options));
    files.sample = toNifti(grid.data, displayWindow(grid.data));
    if (result.cells) {
      files.candidates = encoder.encode(candidateCsv(result.cells, voxelSizeUm));
      files.marks = toNifti(candidateMarks(result.gridPoints, grid.shape, result.spacingUm));
    }
  }
  out.files = files;
  return out;
}
