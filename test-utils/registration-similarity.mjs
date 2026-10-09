// Independent checks for registration tests: similarity metrics, a known rigid
// displacement and a block-mean downsampler, all in plain array code. Nothing
// here calls an app's registration or resampling code, so a test built on it
// cannot agree with the app by construction.
//
// A volume is { data, dims: [nx, ny, nz], affine } with x fastest (NIfTI order)
// and affine as four rows mapping voxel indices to millimetres.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { readNifti } from '../packages/components/src/file-io/NiftiUtils.js';

/**
 * Bytes of a commit-pinned example file, verified against the offline lock and
 * cached under TMPDIR (RUNNER_TEMP in CI) so one job downloads each file once.
 */
export async function fetchPinnedExample(url) {
  const lock = JSON.parse(await readFile(new URL('../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
  const sha256 = lock.assets[url]?.sha256;
  if (!sha256) throw new Error(`${url} is not in registry/offline-assets.lock.json`);
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP, 'neurodesk-registration-examples');
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${sha256}-${url.split('/').pop()}`);
  const cached = await readFile(path).catch(() => null);
  if (cached && createHash('sha256').update(cached).digest('hex') === sha256) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) throw new Error(`${url} has sha256 ${digest}, expected ${sha256}`);
  await writeFile(path, bytes);
  return bytes;
}

/** Decode a (possibly gzipped) NIfTI into a volume with a plain-array affine. */
export async function readVolume(bytes) {
  const { data, dims, header } = await readNifti(bytes);
  return { data, dims, affine: header.affine.map((row) => Array.from(row)) };
}

function assertSameLength(a, b) {
  if (a.length !== b.length) throw new Error(`Length mismatch: ${a.length} and ${b.length}`);
  if (a.length === 0) throw new Error('Similarity needs at least one sample');
}

/** Pearson normalized cross-correlation in [-1, 1]; 0 when either input is constant. */
export function ncc(a, b) {
  assertSameLength(a, b);
  let sumA = 0;
  let sumB = 0;
  for (let index = 0; index < a.length; index += 1) {
    sumA += a[index];
    sumB += b[index];
  }
  const meanA = sumA / a.length;
  const meanB = sumB / a.length;
  let cross = 0;
  let squareA = 0;
  let squareB = 0;
  for (let index = 0; index < a.length; index += 1) {
    const da = a[index] - meanA;
    const db = b[index] - meanB;
    cross += da * db;
    squareA += da * da;
    squareB += db * db;
  }
  if (squareA === 0 || squareB === 0) return 0;
  return cross / Math.sqrt(squareA * squareB);
}

export function meanSquaredError(a, b) {
  assertSameLength(a, b);
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    sum += difference * difference;
  }
  return sum / a.length;
}

export function multiplyAffine(a, b) {
  return a.map((row) => [0, 1, 2, 3].map((column) => row[0] * b[0][column] + row[1] * b[1][column] + row[2] * b[2][column] + row[3] * b[3][column]));
}

export function applyAffine(affine, [x, y, z]) {
  return [0, 1, 2].map((row) => affine[row][0] * x + affine[row][1] * y + affine[row][2] * z + affine[row][3]);
}

/** Largest absolute difference between two affines' first three rows. */
export function affineDifference(a, b) {
  let worst = 0;
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) worst = Math.max(worst, Math.abs(a[row][column] - b[row][column]));
  }
  return worst;
}

/** Mean of each factor^3 block. Output voxel i is centred on input index factor * i + (factor - 1) / 2. */
export function downsampleVolume({ data, dims, affine }, factor) {
  const [nx, ny, nz] = dims;
  const out = [Math.floor(nx / factor), Math.floor(ny / factor), Math.floor(nz / factor)];
  const result = new Float32Array(out[0] * out[1] * out[2]);
  const blockSize = factor ** 3;
  for (let z = 0; z < out[2]; z += 1) {
    for (let y = 0; y < out[1]; y += 1) {
      for (let x = 0; x < out[0]; x += 1) {
        let sum = 0;
        for (let dz = 0; dz < factor; dz += 1) {
          for (let dy = 0; dy < factor; dy += 1) {
            const row = ((z * factor + dz) * ny + y * factor + dy) * nx + x * factor;
            for (let dx = 0; dx < factor; dx += 1) sum += data[row + dx];
          }
        }
        result[(z * out[1] + y) * out[0] + x] = sum / blockSize;
      }
    }
  }
  const shift = (factor - 1) / 2;
  const scale = [
    [factor, 0, 0, shift],
    [0, factor, 0, shift],
    [0, 0, factor, shift],
    [0, 0, 0, 1],
  ];
  return { data: result, dims: out, affine: multiplyAffine(affine, scale) };
}

/**
 * Voxel-space matrix of a rotation about the z axis through the volume centre
 * followed by a translation: sample = R (voxel - centre) + centre + translation.
 */
export function rigidVoxelMatrix(dims, { translationVoxels, rotationDegreesZ }) {
  const angle = rotationDegreesZ * Math.PI / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const centre = dims.map((n) => (n - 1) / 2);
  const rotation = [
    [cos, -sin, 0],
    [sin, cos, 0],
    [0, 0, 1],
  ];
  const matrix = rotation.map((row, index) => [
    ...row,
    centre[index] - (row[0] * centre[0] + row[1] * centre[1] + row[2] * centre[2]) + translationVoxels[index],
  ]);
  return [...matrix, [0, 0, 0, 1]];
}

/** Inverse of an affine whose last row is 0 0 0 1. */
export function invertAffine(affine) {
  const [[a, b, c, tx], [d, e, f, ty], [g, h, i, tz]] = affine;
  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (determinant === 0) throw new Error('Affine is singular');
  const linear = [
    [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
    [(f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
    [(d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant],
  ];
  const inverse = linear.map((row) => [...row, -(row[0] * tx + row[1] * ty + row[2] * tz)]);
  return [...inverse, [0, 0, 0, 1]];
}

/**
 * Trilinear resampling: output(v) = input(matrix v), zero outside. The output
 * keeps the input grid unless a target { dims, affine } is given.
 */
export function resampleVolume({ data, dims, affine }, matrix, target = { dims, affine }) {
  const [nx, ny, nz] = dims;
  const [tx, ty, tz] = target.dims;
  const result = new Float32Array(tx * ty * tz);
  for (let z = 0; z < tz; z += 1) {
    for (let y = 0; y < ty; y += 1) {
      for (let x = 0; x < tx; x += 1) {
        const [sx, sy, sz] = applyAffine(matrix, [x, y, z]);
        const x0 = Math.floor(sx);
        const y0 = Math.floor(sy);
        const z0 = Math.floor(sz);
        if (x0 < 0 || y0 < 0 || z0 < 0 || x0 >= nx - 1 || y0 >= ny - 1 || z0 >= nz - 1) continue;
        const fx = sx - x0;
        const fy = sy - y0;
        const fz = sz - z0;
        let value = 0;
        for (let corner = 0; corner < 8; corner += 1) {
          const cx = corner & 1;
          const cy = (corner >> 1) & 1;
          const cz = corner >> 2;
          const weight = (cx ? fx : 1 - fx) * (cy ? fy : 1 - fy) * (cz ? fz : 1 - fz);
          value += weight * data[((z0 + cz) * ny + y0 + cy) * nx + x0 + cx];
        }
        result[(z * ty + y) * tx + x] = value;
      }
    }
  }
  return { data: result, dims: target.dims, affine: target.affine };
}

/** The moving image on the fixed grid with no registration: world coordinates only. */
export function resampleToGrid(moving, fixed) {
  return resampleVolume(moving, multiplyAffine(invertAffine(moving.affine), fixed.affine), fixed);
}

/** Uncompressed float32 NIfTI-1 with the affine in the sform (and no qform). */
export function encodeNifti({ data, dims, affine }) {
  const header = Buffer.alloc(352);
  header.writeInt32LE(348, 0);
  [3, dims[0], dims[1], dims[2], 1, 1, 1, 1].forEach((value, index) => header.writeInt16LE(value, 40 + index * 2));
  header.writeInt16LE(16, 70);
  header.writeInt16LE(32, 72);
  const spacing = [0, 1, 2].map((column) => Math.hypot(affine[0][column], affine[1][column], affine[2][column]));
  [1, ...spacing, 1, 1, 1, 1].forEach((value, index) => header.writeFloatLE(value, 76 + index * 4));
  header.writeFloatLE(352, 108);
  header.writeFloatLE(1, 112);
  header.writeUInt8(10, 123);
  header.writeInt16LE(0, 252);
  header.writeInt16LE(2, 254);
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 4; column += 1) header.writeFloatLE(affine[row][column], 280 + row * 16 + column * 4);
  }
  header.write('n+1\0', 344, 'latin1');
  const voxels = Float32Array.from(data);
  return Buffer.concat([header, Buffer.from(voxels.buffer, voxels.byteOffset, voxels.byteLength)]);
}

/**
 * An app's declared moving and stationary example, each block-mean downsampled
 * so a CI runner can register the real pair. `files` maps each declared file
 * name to the gzipped NIfTI a test serves in place of the hosted download.
 */
export async function downsampledExamplePair(example, factor) {
  const declared = Object.fromEntries(example.files.map((file) => [file.role, file]));
  const moving = downsampleVolume(await readVolume(await fetchPinnedExample(declared.moving.url)), factor);
  const fixed = downsampleVolume(await readVolume(await fetchPinnedExample(declared.stationary.url)), factor);
  const files = {
    [declared.moving.name]: gzipSync(encodeNifti(moving)),
    [declared.stationary.name]: gzipSync(encodeNifti(fixed)),
  };
  return { moving, fixed, files };
}

/**
 * A copy of `fixed` moved by a known rigid displacement, with the world-space
 * matrix a registration should recover: it maps a fixed point to the moving
 * point showing the same anatomy.
 */
export function displaceVolume(fixed, displacement) {
  const matrix = rigidVoxelMatrix(fixed.dims, displacement);
  const fixedToMoving = multiplyAffine(multiplyAffine(fixed.affine, invertAffine(matrix)), invertAffine(fixed.affine));
  return { moving: resampleVolume(fixed, matrix), fixedToMoving };
}

/** Largest distance in millimetres between two world transforms over the corners of the grid's central half. */
export function transformErrorMm(recovered, expected, { dims, affine }) {
  let worst = 0;
  for (let corner = 0; corner < 8; corner += 1) {
    const voxel = dims.map((n, axis) => (n - 1) * ((corner >> axis) & 1 ? 0.75 : 0.25));
    const point = applyAffine(affine, voxel);
    const a = applyAffine(recovered, point);
    const b = applyAffine(expected, point);
    worst = Math.max(worst, Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]));
  }
  return worst;
}
