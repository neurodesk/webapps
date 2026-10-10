import { readVolume, writeVolume } from '../../synthsr/src/volume.js';
import { ReferenceNeSVoR, fitReference } from './training/index.js';
import { validateBrowserReference } from './reference-config.js';

const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const quantile = (sorted, q) => {
  const position = (sorted.length - 1) * q;
  const i = Math.floor(position);
  return sorted[i] + (sorted[Math.min(i + 1, sorted.length - 1)] - sorted[i]) * (position - i);
};

function axisAngle(columns) {
  const m = [0, 1, 2].map((r) => columns.map((c) => c[r]));
  const cosine = Math.max(-1, Math.min(1, (m[0][0] + m[1][1] + m[2][2] - 1) / 2));
  const angle = Math.acos(cosine);
  if (angle < 1e-7) return [(m[2][1] - m[1][2]) / 2, (m[0][2] - m[2][0]) / 2, (m[1][0] - m[0][1]) / 2];
  if (Math.PI - angle < 1e-5) {
    const axis = [0, 1, 2].map((i) => Math.sqrt(Math.max(0, (m[i][i] + 1) / 2)));
    const largest = axis.indexOf(Math.max(...axis));
    for (let i = 0; i < 3; i++) if (i !== largest) axis[i] = (m[i][largest] + m[largest][i]) / (4 * axis[largest]);
    return axis.map((v) => v * angle);
  }
  const scale = angle / (2 * Math.sin(angle));
  return [m[2][1] - m[1][2], m[0][2] - m[2][0], m[1][0] - m[0][1]].map((v) => v * scale);
}

export function prepareReference(request) {
  const config = validateBrowserReference(request);
  const observations = [];
  const poses = [];
  const sliceColumns = [];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  let maxResolution = 0;
  for (const stack of request.stacks) {
    const image = readVolume(stack.image);
    const mask = readVolume(stack.mask);
    if (image.dims.some((d, i) => d !== mask.dims[i]) || image.affine.some((row, i) => row.some((v, j) => Math.abs(v - mask.affine[i][j]) > 1e-4))) throw new Error('Each reviewed mask must have the same dimensions and affine as its stack.');
    const spacing = [0, 1, 2].map((c) => Math.hypot(...image.affine.slice(0, 3).map((r) => r[c])));
    const columns = spacing.map((s, c) => image.affine.slice(0, 3).map((r) => r[c] / s));
    if (spacing.some((v) => !(v > 0)) || Math.abs(dot(columns[0], columns[1])) > 1e-5 || Math.abs(dot(columns[0], columns[2])) > 1e-5 || Math.abs(dot(columns[1], columns[2])) > 1e-5) throw new Error('Sheared NIfTI affines are not supported by the reference rigid slice model.');
    const handedness = dot(cross(columns[0], columns[1]), columns[2]) < 0 ? -1 : 1;
    columns[0] = columns[0].map((v) => v * handedness);
    const rotation = axisAngle(columns);
    const values = Array.from(image.data).filter((_, i) => mask.data[i] > 0).sort((a, b) => a - b);
    if (!values.length || values.some((v) => v < 0)) throw new Error('Reviewed masks must contain nonnegative tissue intensities.');
    const scale = quantile(values, 0.99);
    if (!(scale > 0)) throw new Error('The masked image has no positive intensities.');
    maxResolution = Math.max(maxResolution, ...spacing.slice(0, 2), stack.thickness);
    const [nx, ny, nz] = image.dims;
    const gaussian = 1 / (2 * Math.sqrt(2 * Math.log(2)));
    const sigma = [spacing[0] * gaussian * 1.206709128803223 / 30, spacing[1] * gaussian * 1.206709128803223 / 30, stack.thickness * gaussian / 30];
    for (let z = 0; z < nz; z++) {
      const start = z * nx * ny;
      if (!mask.data.subarray(start, start + nx * ny).some((v) => v > 0)) continue;
      const centerVoxel = [(nx - 1) / 2, (ny - 1) / 2, z];
      const center = image.affine.slice(0, 3).map((row) => dot(row.slice(0, 3), centerVoxel) + row[3]);
      const slice = poses.length / 6;
      poses.push(...rotation, ...columns.map((column) => dot(column, center) / 30));
      sliceColumns.push(columns);
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const index = start + y * nx + x;
          if (!(mask.data[index] > 0)) continue;
          const local = [(x - (nx - 1) / 2) * spacing[0] * handedness, (y - (ny - 1) / 2) * spacing[1], 0];
          const world = center.map((v, r) => v + columns.reduce((sum, c, i) => sum + c[r] * local[i], 0));
          world.forEach((v, i) => {
            minimum[i] = Math.min(minimum[i], v);
            maximum[i] = Math.max(maximum[i], v);
          });
          observations.push({ slice, xyz: local.map((v) => v / 30), target: image.data[index] / scale, sigma });
          if (observations.length > config.maxObservations) throw new Error(`The experimental CPU reference supports at most ${config.maxObservations} masked voxels. Use an explicitly prepared small validation case; no input is automatically downsampled.`);
        }
      }
    }
  }
  const intensities = observations.map((o) => o.target).sort((a, b) => a - b);
  const low = quantile(intensities, 0.1);
  const high = quantile(intensities, 0.9);
  const middle = intensities.filter((v) => v > low && v < high);
  if (!middle.length) throw new Error('The reference requires tissue intensity variation for its robust mean.');
  const mean = middle.reduce((a, b) => a + b, 0) / middle.length;
  const center = minimum.map((v, i) => (v + maximum[i]) / 2);
  for (let slice = 0; slice < sliceColumns.length; slice++) {
    for (let axis = 0; axis < 3; axis++) poses[slice * 6 + axis + 3] -= dot(sliceColumns[slice][axis], center) / 30;
  }
  const boundingBox = [minimum.map((v, i) => (v - center[i] - 2 * maxResolution) / 30), maximum.map((v, i) => (v - center[i] + 2 * maxResolution) / 30)];
  const dims = minimum.map((v, i) => Math.ceil((maximum[i] - v) / config.outputResolution) + 1);
  if (dims.reduce((a, b) => a * b, 1) > config.maxOutputVoxels) throw new Error(`Requested output exceeds the CPU reference limit of ${config.maxOutputVoxels} voxels. Increase the explicitly selected output resolution or use a smaller validation case.`);
  const affine = [[config.outputResolution, 0, 0, minimum[0]], [0, config.outputResolution, 0, minimum[1]], [0, 0, config.outputResolution, minimum[2]], [0, 0, 0, 1]];
  return { config, observations, poses, mean, boundingBox, dims, affine, center };
}

export async function reconstructReference(request, { signal, onProgress = () => {} } = {}) {
  signal?.throwIfAborted();
  onProgress({ stage: 'preparing', fraction: 0 });
  const prepared = prepareReference(request);
  const { config, observations, poses, mean, boundingBox, dims, affine, center } = prepared;
  const model = new ReferenceNeSVoR({ ...config, boundingBox, poses, mean });
  await fitReference(model, observations, { ...config, signal, onProgress: (progress) => onProgress({ stage: 'training', ...progress, fraction: 0.05 + 0.85 * progress.step / progress.iterations }) });
  const data = new Float32Array(dims.reduce((a, b) => a * b, 1));
  for (let i = 0; i < data.length; i++) {
    const voxel = [i % dims[0], Math.floor(i / dims[0]) % dims[1], Math.floor(i / (dims[0] * dims[1]))];
    const world = affine.slice(0, 3).map((row, axis) => (dot(row.slice(0, 3), voxel) + row[3] - center[axis]) / 30);
    data[i] = model.sample(world);
    if (!Number.isFinite(data[i])) throw new Error('The experimental reconstruction produced a non-finite output.');
    if (i % 128 === 0) {
      signal?.throwIfAborted();
      onProgress({ stage: 'sampling', completed: i, total: data.length, fraction: 0.9 + 0.1 * i / data.length });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  signal?.throwIfAborted();
  onProgress({ stage: 'sampling', completed: data.length, total: data.length, fraction: 1 });
  const provenance = { schema: 1, engine: 'browser-cpu-reference', sourceCommit: '730ddaa3711a2304386de34193ea4b957892fe7b', validated: false, registration: 'none', preset: config, observations: observations.length, slices: poses.length / 6, outputAffine: affine, limitations: ['Experimental reduced model and training budget; not clinical output.', 'No SVoRT, stack registration, learned segmentation or CUDA numerical parity.', 'Output samples the fitted field inside the input mask bounding box; no upstream reconstructed output mask.'] };
  return { volume: writeVolume({ data, dims, affine }, 'EXPERIMENTAL NeSVoR CPU reference; not validated'), provenance, log: `CPU reference fit completed: ${config.iterations} steps, ${observations.length} observations, ${data.length} output voxels. No examination data left this browser.` };
}
