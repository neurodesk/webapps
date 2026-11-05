// One run in a module worker: read the stack, detect cells, register to the Allen atlas and count
// cells per region. The page terminates the worker to cancel, which frees the Greedy heap.
//   in:  { files, voxelSizeUm: [z, y, x], orientation, register, detect }
//   out: { type: 'progress', fraction, message } | { type: 'log', message }
//        { type: 'result', ... } | { type: 'error', message }
import initGreedy, * as greedy from '@neurodesk/greedy/wasm-single';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { createNiftiFromData, decodeNiftiBuffer, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { openMicroscopyStack } from '@neurodesk/webapp-components/file-io/microscopy-stack';
import manifest from '../../../models/lightsheet-atlas.manifest.json';
import { candidateCsv, runPipeline } from './pipeline.js';
import { gridHeader, gridNifti } from './registration.js';

const post = (message, transfer = []) => self.postMessage(message, transfer);
const asset = (id) => manifest.assets.find((entry) => entry.id === id);

async function download(id, from, to) {
  const entry = asset(id);
  return fetchModel({ url: entry.url, integrity: { bytes: entry.bytes, sha256: entry.sha256 } }, {
    retries: 2,
    onProgress: ({ fraction }) => post({ type: 'progress', fraction: from + (to - from) * (fraction || 0), message: `Downloading the Allen atlas (${entry.filename})` }),
  });
}

async function loadAtlas() {
  const started = performance.now();
  const template = await decodeNiftiBuffer(await download('template', 0.3, 0.32));
  const annotation = await decodeNiftiBuffer(await download('annotation', 0.32, 0.33));
  const structures = JSON.parse(new TextDecoder().decode(await download('structures', 0.33, 0.34)));
  post({ type: 'log', message: `Allen CCFv3 50 µm atlas ready in ${((performance.now() - started) / 1000).toFixed(1)} s` });
  return { template, annotation, structures, annotationData: readNiftiImageData(annotation, Uint16Array).data };
}

// A label volume marking each cell's grid voxel and its six neighbours, so cells stay visible.
function cellMarks(points, shape) {
  const [A, S, R] = shape;
  const marks = new Uint8Array(A * S * R);
  for (const point of points) {
    const [a, s, r] = point.map(Math.round);
    for (const [da, ds, dr] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]) {
      const [x, y, z] = [a + da, s + ds, r + dr];
      if (x >= 0 && y >= 0 && z >= 0 && x < A && y < S && z < R) marks[x + A * (y + S * z)] = 1;
    }
  }
  return marks;
}

self.onmessage = async ({ data: job }) => {
  try {
    const stack = await openMicroscopyStack(job.files);
    let api = null;
    if (job.register) {
      await initGreedy();
      api = greedy;
    }
    const result = await runPipeline({
      stack,
      voxelSizeUm: job.voxelSizeUm,
      orientation: job.orientation,
      register: job.register,
      detect: job.detect,
      loadAtlas,
      greedy: api,
      onProgress: (fraction, message) => post({ type: 'progress', fraction, message }),
      onLog: (message) => post({ type: 'log', message }),
    });
    const { grid } = result;
    const out = { type: 'result', gridShape: grid.shape, spacingUm: result.spacingUm, cellCount: result.cells?.length ?? null };
    const files = {};
    if (job.register) {
      const atlasHeader = result.atlasTemplate;
      files.sample = gridNifti(grid.data, grid.shape, atlasHeader);
      files.labels = gridNifti(result.labels, grid.shape, atlasHeader);
      const ids = new Uint32Array(result.labels.length);
      for (let i = 0; i < ids.length; i++) ids[i] = result.labels[i] ? result.table.byIndex.get(result.labels[i]).id : 0;
      files.registeredAtlas = gridNifti(ids, grid.shape, atlasHeader);
      files.regions = new TextEncoder().encode(result.regionCsv);
      out.labelColormap = labelColormap(result.table, result.labels);
      out.regionRows = result.rows.length;
      out.matrix = result.matrix;
      out.assignedCells = result.assigned ? result.assigned.filter((cell) => cell.index).length : null;
      if (result.cells) {
        files.cells = new TextEncoder().encode(result.cellCsv);
        files.marks = gridNifti(cellMarks(result.gridPoints, grid.shape), grid.shape, atlasHeader);
      }
    } else {
      const header = gridHeader(grid.shape, result.spacingUm);
      const toNifti = (data) => new Uint8Array(createNiftiFromData(data, header, { range: 'auto' }));
      files.sample = toNifti(grid.data);
      if (result.cells) {
        files.cells = new TextEncoder().encode(candidateCsv(result.cells, job.voxelSizeUm));
        files.marks = toNifti(cellMarks(result.gridPoints, grid.shape));
      }
    }
    out.files = files;
    post(out, Object.values(files).map((value) => value.buffer));
  } catch (error) {
    post({ type: 'error', message: error?.message ?? String(error) });
  }
};

// NiiVue's label colormap for the indices present: Allen colours and acronyms.
function labelColormap(table, labels) {
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
