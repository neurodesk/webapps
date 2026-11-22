import * as nifti from 'nifti-reader-js';

const product = (shape) => shape.reduce((total, value) => total * value, 1);
const SPATIAL_UNIT_SCALE = { 1: 1000, 2: 1, 3: 0.001 };
export const MAX_CONFORM_MEMORY_BYTES = 768 * 1024 * 1024;

function spatialPixDims(header) {
  const spacing = header.pixDims?.slice(1, 4);
  if (!spacing || spacing.length !== 3 || spacing.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('The NIfTI voxel spacing must be finite and positive.');
  }
  return spacing;
}

// Builds the unscaled qform affine following the NIfTI reference
// (`nifti_quatern_to_dmat44`): normalizes (b, c, d) with a = 0 when
// 1 - (b^2 + c^2 + d^2) < 1e-7 so 180° rotations never produce NaN.
function qformAffine(header) {
  const [dx, dy, dzBase] = spatialPixDims(header);
  let b = header.quatern_b;
  let c = header.quatern_c;
  let d = header.quatern_d;
  const norm2 = b * b + c * c + d * d;
  if (!Number.isFinite(norm2)) throw new Error('The NIfTI affine contains non-finite values.');
  const a2 = 1 - norm2;
  let a;
  if (a2 < 1e-7) {
    const norm = Math.sqrt(norm2);
    b /= norm;
    c /= norm;
    d /= norm;
    a = 0;
  } else {
    a = Math.sqrt(a2);
  }
  const qfac = header.pixDims[0] < 0 ? -1 : 1;
  const dz = dzBase * qfac;
  return [
    [(a * a + b * b - c * c - d * d) * dx, (2 * b * c - 2 * a * d) * dy, (2 * b * d + 2 * a * c) * dz, header.qoffset_x],
    [(2 * b * c + 2 * a * d) * dx, (a * a + c * c - b * b - d * d) * dy, (2 * c * d - 2 * a * b) * dz, header.qoffset_y],
    [(2 * b * d - 2 * a * c) * dx, (2 * c * d + 2 * a * b) * dy, (a * a + d * d - c * c - b * b) * dz, header.qoffset_z],
  ];
}

// Reads a NIfTI-1 or NIfTI-2 header from either a full file buffer or a
// 540-byte uncompressed prefix. Slicing to the fixed header size avoids walking
// into NIfTI extensions when only the prefix was streamed.
export function readVolumeHeader(buffer) {
  const source = nifti.isCompressed(buffer) ? nifti.decompress(buffer) : buffer;
  if (!nifti.isNIFTI(source)) throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
  const headerLength = nifti.isNIFTI2(source) ? 540 : 348;
  if (source.byteLength < headerLength) throw new Error('The NIfTI header is truncated.');
  return nifti.readHeader(source.slice(0, headerLength));
}

// Resolves a NIfTI-1 or NIfTI-2 header to a finite, invertible 4x4 voxel-to-RAS
// affine in millimetres. Uses the qform when qform_code > 0 and sform_code < qform_code,
// the sform when sform_code > 0, or a pixDims diagonal when neither code is set.
export function resolveWorldAffine(header) {
  const qformCode = header.qform_code ?? 0;
  const sformCode = header.sform_code ?? 0;
  let raw;
  if (qformCode > 0 && sformCode < qformCode) {
    raw = qformAffine(header);
  } else if (sformCode > 0) {
    raw = header.affine.slice(0, 3).map((row) => row.slice(0, 4));
  } else {
    const [dx, dy, dz] = spatialPixDims(header);
    raw = [
      [dx, 0, 0, 0],
      [0, dy, 0, 0],
      [0, 0, dz, 0],
    ];
  }
  const scale = SPATIAL_UNIT_SCALE[header.xyzt_units & 7] ?? 1;
  const affine = [
    raw[0].map((value) => value * scale),
    raw[1].map((value) => value * scale),
    raw[2].map((value) => value * scale),
    [0, 0, 0, 1],
  ];
  if (affine.some((row) => row.length !== 4 || row.some((value) => !Number.isFinite(value)))) {
    throw new Error('The NIfTI affine contains non-finite values.');
  }
  inverseAffine(affine);
  return affine;
}

export function readVolume(buffer) {
  const source = nifti.isCompressed(buffer) ? nifti.decompress(buffer) : buffer;
  if (!nifti.isNIFTI(source)) throw new Error('Choose a NIfTI image (.nii or .nii.gz).');
  const header = nifti.readHeader(source);
  if (header.dims[0] !== 3 || header.dims.slice(4, header.dims[0] + 1).some((size) => size > 1)) {
    throw new Error('TopoFit needs one three-dimensional image.');
  }
  const dims = header.dims.slice(1, 4);
  const voxelCount = product(dims);
  if (dims.some((size) => !Number.isInteger(size) || size < 2) || voxelCount > 128 * 1024 * 1024) {
    throw new Error('The NIfTI dimensions are unsupported.');
  }
  const types = {
    2: ['getUint8', 1],
    4: ['getInt16', 2],
    8: ['getInt32', 4],
    16: ['getFloat32', 4],
    64: ['getFloat64', 8],
    256: ['getInt8', 1],
    512: ['getUint16', 2],
    768: ['getUint32', 4],
  };
  const type = types[header.datatypeCode];
  if (!type) throw new Error(`Unsupported NIfTI datatype ${header.datatypeCode}.`);
  const raw = nifti.readImage(header, source);
  if (raw.byteLength < voxelCount * type[1]) throw new Error('The NIfTI image is truncated.');
  const retainedBytes = source === buffer ? source.byteLength : source.byteLength + buffer.byteLength;
  if (estimateConformMemoryBytes(dims, retainedBytes) > MAX_CONFORM_MEMORY_BYTES) {
    throw new Error('This image is too large to conform safely in the browser. Crop or resample it before loading.');
  }
  const view = new DataView(raw);
  const slope = header.scl_slope || 1;
  const intercept = header.scl_slope ? header.scl_inter : 0;
  const data = new Float64Array(voxelCount);
  for (let i = 0; i < voxelCount; i += 1) {
    data[i] = view[type[0]](i * type[1], header.littleEndian) * slope + intercept;
    if (!Number.isFinite(data[i])) throw new Error('The image contains non-finite intensities.');
  }
  const affine = resolveWorldAffine(header);
  const scaled = Boolean(header.scl_slope) && (slope !== 1 || intercept !== 0);
  return {
    data,
    dims,
    affine,
    source,
    header,
    datatypeCode: scaled ? 64 : header.datatypeCode,
    storageDatatypeCode: header.datatypeCode,
  };
}

export function estimateConformMemoryBytes(dims, retainedBytes = 0) {
  const source = product(dims);
  const dimsAscending = [...dims].sort((a, b) => a - b);
  const afterX = 256 * dimsAscending[1] * dimsAscending[2];
  const afterY = 256 * 256 * dimsAscending[2];
  const target = 256 * 256 * 256;
  const simultaneousFloat64 = Math.max(
    2 * source + afterX,
    source + afterX + afterY,
    source + afterY + target,
    3 * source + target + target / 2,
  );
  return retainedBytes + simultaneousFloat64 * Float64Array.BYTES_PER_ELEMENT;
}

export function needsConform(affine, relativeTolerance = 1e-5) {
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      const expected = row === column ? 1 : 0;
      if (!(Math.abs(affine[row][column] - expected) <= 1e-8 + relativeTolerance * expected)) return true;
    }
  }
  return false;
}

export function axisAlignedVoxelSpacing(affine, tolerance = 1e-5) {
  const spacing = [0, 1, 2].map((column) =>
    Math.hypot(affine[0][column], affine[1][column], affine[2][column]),
  );
  if (spacing.some((value) => !Number.isFinite(value) || value <= 0)) {
    throw new Error('Browser conforming requires a valid spatial affine.');
  }
  const direction = affine.slice(0, 3).map((row) =>
    row.slice(0, 3).map((value, column) => value / spacing[column]),
  );
  for (let axis = 0; axis < 3; axis += 1) {
    const row = direction[axis].filter((value) => Math.abs(value) > tolerance);
    const column = direction.map((values) => values[axis]).filter((value) => Math.abs(value) > tolerance);
    if (
      row.length !== 1 ||
      column.length !== 1 ||
      Math.abs(Math.abs(row[0]) - 1) > tolerance ||
      Math.abs(Math.abs(column[0]) - 1) > tolerance
    ) {
      throw new Error('Browser conforming currently requires an axis-aligned scan. Conform oblique images to 1 mm RAS before loading.');
    }
  }
  return spacing;
}

export function cropAndNormalize(volume, outSize, center) {
  const offset = outSize.map((size, axis) => {
    const half = 0.5 * (size - 1);
    return Math.ceil(center[axis] - half);
  });
  const output = new Float32Array(product(outSize));
  let target = 0;
  for (let x = 0; x < outSize[0]; x += 1) {
    const sourceX = x + offset[0];
    for (let y = 0; y < outSize[1]; y += 1) {
      const sourceY = y + offset[1];
      for (let z = 0; z < outSize[2]; z += 1) {
        const sourceZ = z + offset[2];
        let value = 0;
        if (
          sourceX >= 0 &&
          sourceY >= 0 &&
          sourceZ >= 0 &&
          sourceX < volume.dims[0] &&
          sourceY < volume.dims[1] &&
          sourceZ < volume.dims[2]
        ) {
          const sourceIndex = sourceX + volume.dims[0] * (sourceY + volume.dims[1] * sourceZ);
          value = volume.data[sourceIndex];
        }
        output[target] = value;
        target += 1;
      }
    }
  }
  const values = output.slice();
  const low = selectQuantile(values, 0.001);
  const high = selectQuantile(values, 0.999);
  const span = high - low;
  for (let i = 0; i < output.length; i += 1) {
    output[i] = Math.max(0, Math.min(1, span > 0 ? (output[i] - low) / span : output[i] - low));
  }
  return { data: output, dims: [...outSize], affine: adjustAffine(volume.affine, offset), offset };
}

export function imageCenter(dims) {
  return dims.map((size) => Math.floor(0.5 * (size - 1)) + 0.5);
}

export function surfaceCenter(left, right) {
  const points = [left, right];
  const minimum = [Infinity, Infinity, Infinity];
  const maximum = [-Infinity, -Infinity, -Infinity];
  for (const vertices of points) {
    for (let i = 0; i < vertices.length; i += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        minimum[axis] = Math.min(minimum[axis], vertices[i + axis]);
        maximum[axis] = Math.max(maximum[axis], vertices[i + axis]);
      }
    }
  }
  return minimum.map((value, axis) => Math.floor(0.5 * (value + maximum[axis])) + 0.5);
}

export function adjustAffine(affine, offset) {
  const output = affine.map((row) => [...row]);
  for (let row = 0; row < 3; row += 1) {
    output[row][3] += affine[row][0] * offset[0] + affine[row][1] * offset[1] + affine[row][2] * offset[2];
  }
  return output;
}

export function applyAffine(affine, vertices) {
  const output = new Float32Array(vertices.length);
  for (let i = 0; i < vertices.length; i += 3) {
    for (let row = 0; row < 3; row += 1) {
      output[i + row] =
        affine[row][0] * vertices[i] +
        affine[row][1] * vertices[i + 1] +
        affine[row][2] * vertices[i + 2] +
        affine[row][3];
    }
  }
  return output;
}

export function inverseAffine(matrix) {
  const augmented = matrix.map((row, index) => [...row, ...[0, 1, 2, 3].map((column) => Number(index === column))]);
  for (let column = 0; column < 4; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 4; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) pivot = row;
    }
    if (!Number.isFinite(augmented[pivot][column]) || Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('The NIfTI affine is singular.');
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    for (let entry = 0; entry < 8; entry += 1) augmented[column][entry] /= divisor;
    for (let row = 0; row < 4; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let entry = 0; entry < 8; entry += 1) augmented[row][entry] -= factor * augmented[column][entry];
    }
  }
  return augmented.map((row) => row.slice(4));
}

// Reads the same two order statistics a full TypedArray sort would, partially sorting `values`
// in place; `values` must be finite. Selection with < cannot tell -0 from +0, which the sort
// places first, so a zero result is resolved by counting.
export function selectQuantile(values, probability) {
  const position = (values.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  const upper = Math.min(values.length - 1, lower + 1);
  select(values, lower, 0, values.length - 1);
  select(values, upper, upper, values.length - 1);
  let lowValue = values[lower];
  let upperValue = values[upper];
  if (lowValue === 0 || upperValue === 0) {
    let negatives = 0;
    let negativeZeros = 0;
    for (let i = 0; i < values.length; i += 1) {
      if (values[i] < 0) negatives += 1;
      else if (values[i] === 0 && 1 / values[i] < 0) negativeZeros += 1;
    }
    if (lowValue === 0) lowValue = lower - negatives < negativeZeros ? -0 : 0;
    if (upperValue === 0) upperValue = upper - negatives < negativeZeros ? -0 : 0;
  }
  return lowValue + fraction * (upperValue - lowValue);
}

function select(values, k, left, right) {
  while (right > left) {
    const middle = (left + right) >> 1;
    const a = values[left];
    const b = values[middle];
    const c = values[right];
    const pivot = a < b ? (b < c ? b : a < c ? c : a) : (a < c ? a : b < c ? c : b);
    let i = left;
    let j = right;
    while (i <= j) {
      while (values[i] < pivot) i += 1;
      while (values[j] > pivot) j -= 1;
      if (i <= j) {
        const swap = values[i];
        values[i] = values[j];
        values[j] = swap;
        i += 1;
        j -= 1;
      }
    }
    if (k <= j) right = j;
    else if (k >= i) left = i;
    else return;
  }
}
