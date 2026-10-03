import { readNiftiHeader } from './input-inspection.js';
import { parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';
import * as z from 'zod/v4';

const triple = value => z.tuple([z.literal(value), z.literal(value), z.literal(value)]);
const synthsegLimitSchema = z.strictObject({
  geometry: z.literal('synthseg-1mm-ras-padded-v1'),
  targetVoxelSizeMm: triple(1),
  resamplingToleranceMm: z.tuple([z.literal(0.95), z.literal(1.05)]),
  paddingMultiple: z.literal(32),
  minimumShape: triple(128),
  spatialUnitsPolicy: z.literal('numeric-values-as-mm'),
  maxBufferBytes: z.literal(2147483647),
  bytesPerPaddedVoxel: z.literal(288),
  maxPaddedVoxels: z.literal(7456540),
  deferredFormats: z.tuple([z.literal('dicom')]),
  description: z.string().min(1),
});

export const operationLimitsSchema = z.strictObject({
  browser: z.strictObject({
    inputs: z.record(z.string().regex(/^[a-z][a-zA-Z0-9_-]*$/), synthsegLimitSchema),
  }),
});

const product = dims => dims.reduce((a, b) => a * b, 1);


function inverse3(m) {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) throw new Error('The image affine is singular.');
  return [
    [e * i - f * h, c * h - b * i, b * f - c * e],
    [f * g - d * i, a * i - c * g, c * d - a * f],
    [d * h - e * g, b * g - a * h, a * e - b * d],
  ].map(row => row.map(value => value / det));
}

function rasAxes(affine) {
  const inverse = inverse3(affine);
  const axes = [0, 1, 2].map(column => [0, 1, 2].reduce((a, b) =>
    Math.abs(inverse[a][column]) >= Math.abs(inverse[b][column]) ? a : b));
  for (let axis = 0; axis < 3; axis++) {
    if (axes.includes(axis)) continue;
    const counts = [0, 1, 2].map(value => axes.filter(a => a === value).length);
    const most = counts.indexOf(Math.max(...counts));
    axes[axes.lastIndexOf(most)] = axis;
  }
  return axes;
}

function synthsegHeader(bytes) {
  if (bytes.length < 352 || bytes.toString('ascii', 344, 347) !== 'n+1') {
    throw new Error('SynthSeg requires a NIfTI-1 image (.nii or .nii.gz).');
  }
  const normalized = Buffer.from(bytes.subarray(0, 352));
  if (normalized.readInt32LE(0) !== 348) {
    if (normalized.readInt32BE(0) !== 348) throw new Error('Invalid NIfTI-1 header size.');
    for (const [start, end] of [[40, 56], [70, 74], [252, 256]]) normalized.subarray(start, end).swap16();
    for (const [start, end] of [[76, 120], [256, 328]]) normalized.subarray(start, end).swap32();
  }
  const header = parseNiftiHeader(normalized);
  const dims = [header.nx, header.ny, header.nz];
  const ndim = header.dims[0];
  if (ndim < 3 || header.dims.slice(5, Math.min(ndim, 7) + 1).some(d => d > 1)) {
    throw new Error('SynthSeg needs a 3D image (or 4D multichannel).');
  }
  const channels = ndim >= 4 ? Math.max(1, header.dims[4]) : 1;
  if (dims.some(d => d < 2) || product(dims) * channels > 256 * 1024 * 1024) {
    throw new Error('Unsupported image dimensions.');
  }
  if (![2, 256, 4, 512, 8, 768, 16, 64].includes(header.datatype)) {
    throw new Error(`Unsupported NIfTI datatype ${header.datatype}. Use a scalar intensity image.`);
  }
  let affine = header.affine.slice(0, 3).map(row => Array.from(row));
  const qcode = normalized.readInt16LE(252);
  const scode = normalized.readInt16LE(254);
  if (scode <= 0 && qcode > 0) {
    // Preserve exes/synthseg/src/nifti.rs arithmetic order: tiny differences in
    // quaternion-derived spacing can change its ceil-based resampling grid.
    const [b, c, d] = [256, 260, 264].map(offset => normalized.readFloatLE(offset));
    const a = Math.sqrt(Math.max(0, 1 - (b * b + c * c + d * d)));
    const rotation = [
      [a * a + b * b - c * c - d * d, 2 * b * c - 2 * a * d, 2 * b * d + 2 * a * c],
      [2 * b * c + 2 * a * d, a * a + c * c - b * b - d * d, 2 * c * d - 2 * a * b],
      [2 * b * d - 2 * a * c, 2 * c * d + 2 * a * b, a * a + d * d - c * c - b * b],
    ];
    const qfac = header.pixDims[0] < 0 ? -1 : 1;
    affine = rotation.map((row, r) => [
      ...row.map((value, k) => value * header.pixDims[k + 1] * (k === 2 ? qfac : 1)),
      normalized.readFloatLE(268 + 4 * r),
    ]);
  } else if (scode <= 0) {
    affine = [0, 1, 2].map(r => {
      const zoom = header.pixDims[r + 1] * (r === 0 ? -1 : 1);
      return [...[0, 1, 2].map(c => c === r ? zoom : 0), -zoom * (dims[r] - 1) / 2];
    });
  }
  if (affine.flat().some(value => !Number.isFinite(value))) throw new Error('Invalid NIfTI affine.');
  inverse3(affine);
  return { dims, pixdim: header.pixDims.slice(1, 4).map(Math.abs), affine };
}

/** Header-only equivalent of the current SynthSeg Rust prepare() geometry. */
export function planSynthsegGeometry(headerBytes) {
  const { dims, pixdim, affine } = synthsegHeader(Buffer.from(headerBytes));
  let shape = dims;
  if (pixdim.some(p => !(p >= 0.95 && p <= 1.05))) {
    const factors = [0, 1, 2].map(a => Math.sqrt([0, 1, 2].reduce((sum, r) => sum + affine[r][a] * affine[r][a], 0)));
    if (factors.some(f => !(f >= 0.05 && f <= 20))) throw new Error('Voxel spacing is outside the supported range (0.05–20 mm).');
    shape = factors.map((factor, axis) => {
      const start = -(factor - 1) / (2 * factor);
      const step = 1 / factor;
      return Math.ceil(((start + step * Math.ceil(dims[axis] * factor)) - start) / step);
    });
    if (product(shape) > 64 * 1024 * 1024) throw new Error('The 1 mm image is too large.');
    for (let r = 0; r < 3; r++) for (let a = 0; a < 3; a++) affine[r][a] /= factors[a];
  }
  const axes = rasAxes(affine);
  const aligned = axes.map(axis => shape[axis]);
  const paddedShape = aligned.map(size => Math.max(128, Math.ceil(size / 32) * 32));
  const paddedVoxels = product(paddedShape);
  if (paddedVoxels > 64 * 1024 * 1024 || aligned.some(size => size > 32767)) throw new Error('The 1 mm image is too large.');
  return { inputShape: dims, resampledShape: shape, alignedShape: aligned, paddedShape, paddedVoxels };
}

export async function validateOperationLimits(operation, request) {
  if (request.engine !== 'browser' || !operation.limits) return;
  for (const [role, limit] of Object.entries(operation.limits.browser.inputs)) {
    for (const path of request.inputs[role] ?? []) {
      // Conversion determines DICOM geometry; the existing browser runtime cap
      // remains authoritative after conversion, as declared by deferredFormats.
      if (!/\.nii(?:\.gz)?$/i.test(path)) continue;
      const geometry = planSynthsegGeometry(await readNiftiHeader(path));
      const requiredBufferBytes = geometry.paddedVoxels * limit.bytesPerPaddedVoxel;
      if (geometry.paddedVoxels <= limit.maxPaddedVoxels && requiredBufferBytes <= limit.maxBufferBytes) continue;
      const error = new Error(`${role}: SynthSeg browser input ${geometry.inputShape.join('×')} becomes ${geometry.resampledShape.join('×')} at 1 mm, padded to ${geometry.paddedShape.join('×')}; it needs a ${(requiredBufferBytes / 2 ** 30).toFixed(2)} GiB GPU buffer, above the validated 2 GiB limit (${limit.maxBufferBytes} bytes). Use engine "native" if available; reducing source resolution alone does not reduce the resampled field of view.`);
      error.code = 'INPUT_RESOURCE_LIMIT';
      error.details = { role, engine: request.engine, ...geometry, requiredBufferBytes, maxBufferBytes: limit.maxBufferBytes, maxPaddedVoxels: limit.maxPaddedVoxels };
      throw error;
    }
  }
}
