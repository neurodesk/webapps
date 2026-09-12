import * as nifti from 'nifti-reader-js';

const product = (shape) => shape.reduce((total, value) => total * value, 1);
export const MAX_CONFORM_MEMORY_BYTES = 768 * 1024 * 1024;

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
  const unit = header.xyzt_units & 7;
  const scale = unit === 1 ? 1000 : unit === 3 ? 0.001 : 1;
  const affine = header.affine.map((row, rowIndex) =>
    row.map((value) => (rowIndex < 3 ? value * scale : value)),
  );
  inverseAffine(affine);
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
  const afterX = 256 * dims[1] * dims[2];
  const afterY = 256 * 256 * dims[2];
  const target = 256 * 256 * 256;
  const simultaneousFloat64 = Math.max(
    2 * source + afterX,
    source + afterX + afterY,
    source + afterY + target,
    source + target + target / 2,
  );
  return retainedBytes + simultaneousFloat64 * Float64Array.BYTES_PER_ELEMENT;
}

export function needsConform(affine, tolerance = 1e-5) {
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (Math.abs(affine[row][column] - (row === column ? 1 : 0)) > tolerance) return true;
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
  values.sort();
  const low = quantile(values, 0.001);
  const high = quantile(values, 0.999);
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
    if (Math.abs(augmented[pivot][column]) < 1e-12) throw new Error('The NIfTI affine is singular.');
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

function quantile(sorted, probability) {
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const fraction = position - lower;
  return sorted[lower] + fraction * (sorted[Math.min(sorted.length - 1, lower + 1)] - sorted[lower]);
}
