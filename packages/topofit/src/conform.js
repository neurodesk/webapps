import { inverseAffine } from './volume.js';

const CUBIC_POLE = -0.267949192431122706472553658494127633;
const DEFAULT_SHAPE = [256, 256, 256];

export function conformVolume(volume, options = {}) {
  const shape = options.shape || DEFAULT_SHAPE;
  const canonical = reorientToRas(volume);
  const affine = conformedAffine(canonical.affine, canonical.dims, shape);
  const mapping = multiply(inverseAffine(canonical.affine), affine);
  assertDiagonalMapping(mapping);

  let data = canonical.data;
  splineFilter(data, canonical.dims);
  let dims = canonical.dims;
  for (let axis = 0; axis < 3; axis += 1) {
    const coordinates = Array.from(
      { length: shape[axis] },
      (_, index) => mapping[axis][axis] * index + mapping[axis][3],
    );
    data = interpolateAxis(data, dims, axis, coordinates);
    dims = dims.map((size, currentAxis) => currentAxis === axis ? shape[axis] : size);
    options.onProgress?.((axis + 1) / 3);
  }

  return {
    data: castLikeSciPy(data, volume.datatypeCode ?? volume.header?.datatypeCode ?? 16),
    dims: [...shape],
    affine,
    datatypeCode: volume.datatypeCode ?? volume.header?.datatypeCode ?? 16,
  };
}

function reorientToRas(volume, tolerance = 1e-5) {
  const inputForOutput = new Array(3);
  const signs = new Array(3);
  const usedWorldAxes = new Set();
  for (let inputAxis = 0; inputAxis < 3; inputAxis += 1) {
    const column = volume.affine.slice(0, 3).map((row) => row[inputAxis]);
    const spacing = Math.hypot(...column);
    if (!Number.isFinite(spacing) || spacing <= 0) throw new Error('Browser conforming requires a valid spatial affine.');
    let worldAxis = 0;
    for (let row = 1; row < 3; row += 1) {
      if (Math.abs(column[row]) > Math.abs(column[worldAxis])) worldAxis = row;
    }
    if (
      usedWorldAxes.has(worldAxis) ||
      Math.abs(Math.abs(column[worldAxis]) / spacing - 1) > tolerance
    ) {
      throw new Error('Browser conforming currently requires an axis-aligned scan. Conform oblique images to 1 mm RAS before loading.');
    }
    usedWorldAxes.add(worldAxis);
    inputForOutput[worldAxis] = inputAxis;
    signs[worldAxis] = Math.sign(column[worldAxis]);
  }

  const dims = inputForOutput.map((inputAxis) => volume.dims[inputAxis]);
  const data = new Float64Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z += 1) {
    for (let y = 0; y < dims[1]; y += 1) {
      for (let x = 0; x < dims[0]; x += 1) {
        const outputCoordinates = [x, y, z];
        const inputCoordinates = [0, 0, 0];
        for (let outputAxis = 0; outputAxis < 3; outputAxis += 1) {
          const inputAxis = inputForOutput[outputAxis];
          inputCoordinates[inputAxis] = signs[outputAxis] > 0
            ? outputCoordinates[outputAxis]
            : volume.dims[inputAxis] - 1 - outputCoordinates[outputAxis];
        }
        const source = inputCoordinates[0] + volume.dims[0] * (
          inputCoordinates[1] + volume.dims[1] * inputCoordinates[2]
        );
        const target = x + dims[0] * (y + dims[1] * z);
        data[target] = volume.data[source];
      }
    }
  }

  const affine = volume.affine.map((row) => [...row]);
  for (let row = 0; row < 3; row += 1) {
    affine[row][3] = volume.affine[row][3];
    for (let outputAxis = 0; outputAxis < 3; outputAxis += 1) {
      const inputAxis = inputForOutput[outputAxis];
      affine[row][outputAxis] = volume.affine[row][inputAxis] * signs[outputAxis];
      if (signs[outputAxis] < 0) {
        affine[row][3] += volume.affine[row][inputAxis] * (volume.dims[inputAxis] - 1);
      }
    }
  }
  return { data, dims, affine };
}

function conformedAffine(affine, sourceShape, targetShape) {
  const output = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 1],
  ];
  const sourceCenter = sourceShape.map((size) => Math.floor((size - 1) / 2));
  const targetCenter = targetShape.map((size) => Math.floor((size - 1) / 2));
  const worldCenter = affine.slice(0, 3).map((row) =>
    row[3] + row[0] * sourceCenter[0] + row[1] * sourceCenter[1] + row[2] * sourceCenter[2]
  );
  for (let column = 0; column < 3; column += 1) {
    const spacing = Math.hypot(affine[0][column], affine[1][column], affine[2][column]);
    for (let row = 0; row < 3; row += 1) output[row][column] = cleanZero(affine[row][column] / spacing);
  }
  for (let row = 0; row < 3; row += 1) {
    output[row][3] = cleanZero(
      worldCenter[row] - output[row][0] * targetCenter[0]
        - output[row][1] * targetCenter[1]
        - output[row][2] * targetCenter[2],
    );
  }
  return output;
}

function splineFilter(data, dims) {
  const gain = (1 - CUBIC_POLE) * (1 - 1 / CUBIC_POLE);
  for (let axis = 0; axis < 3; axis += 1) {
    const stride = axis === 0 ? 1 : dims.slice(0, axis).reduce((total, size) => total * size, 1);
    const lineLength = dims[axis];
    const lineCount = data.length / lineLength;
    for (let line = 0; line < lineCount; line += 1) {
      const inner = line % stride;
      const outer = Math.floor(line / stride);
      const offset = inner + outer * stride * lineLength;
      filterLine(data, offset, stride, lineLength, gain);
    }
  }
}

function filterLine(data, offset, stride, length, gain) {
  if (length === 1) return;
  for (let index = 0; index < length; index += 1) data[offset + index * stride] *= gain;
  let zPower = CUBIC_POLE;
  const zLast = CUBIC_POLE ** (length - 1);
  let causal = data[offset] + zLast * data[offset + (length - 1) * stride];
  for (let index = 1; index <= length - 2; index += 1) {
    causal += zPower * (
      data[offset + index * stride] + zLast * data[offset + (length - 1 - index) * stride]
    );
    zPower *= CUBIC_POLE;
  }
  data[offset] = causal / (1 - zLast * zLast);
  for (let index = 1; index < length; index += 1) {
    const at = offset + index * stride;
    data[at] += CUBIC_POLE * data[at - stride];
  }
  const last = offset + (length - 1) * stride;
  data[last] = (
    CUBIC_POLE * data[last - stride] + data[last]
  ) * CUBIC_POLE / (CUBIC_POLE * CUBIC_POLE - 1);
  for (let index = length - 2; index >= 0; index -= 1) {
    const at = offset + index * stride;
    data[at] = CUBIC_POLE * (data[at + stride] - data[at]);
  }
}

function interpolateAxis(input, dims, axis, coordinates) {
  const outputDims = dims.map((size, currentAxis) => currentAxis === axis ? coordinates.length : size);
  const output = new Float64Array(outputDims[0] * outputDims[1] * outputDims[2]);
  for (let z = 0; z < outputDims[2]; z += 1) {
    for (let y = 0; y < outputDims[1]; y += 1) {
      for (let x = 0; x < outputDims[0]; x += 1) {
        const targetCoordinates = [x, y, z];
        const coordinate = coordinates[targetCoordinates[axis]];
        if (coordinate < 0 || coordinate > dims[axis] - 1) continue;
        const start = Math.floor(coordinate) - 1;
        const weights = cubicWeights(coordinate);
        let value = 0;
        for (let tap = 0; tap < 4; tap += 1) {
          const sourceCoordinates = [...targetCoordinates];
          sourceCoordinates[axis] = mirror(start + tap, dims[axis]);
          const source = sourceCoordinates[0] + dims[0] * (
            sourceCoordinates[1] + dims[1] * sourceCoordinates[2]
          );
          value += input[source] * weights[tap];
        }
        const target = x + outputDims[0] * (y + outputDims[1] * z);
        output[target] = value;
      }
    }
  }
  return output;
}

function cubicWeights(coordinate) {
  const x = coordinate - Math.floor(coordinate);
  const z = 1 - x;
  const weights = new Float64Array(4);
  weights[1] = (x * x * (x - 2) * 3 + 4) / 6;
  weights[2] = (z * z * (z - 2) * 3 + 4) / 6;
  weights[0] = z * z * z / 6;
  weights[3] = 1 - weights[0] - weights[1] - weights[2];
  return weights;
}

function mirror(index, length) {
  let output = index;
  while (output < 0 || output >= length) {
    output = output < 0 ? -output : 2 * length - output - 2;
  }
  return output;
}

function castLikeSciPy(data, datatypeCode) {
  const integerRanges = {
    2: [0, 255],
    4: [-32768, 32767],
    8: [-2147483648, 2147483647],
    256: [-128, 127],
    512: [0, 65535],
    768: [0, 4294967295],
  };
  const output = new Float32Array(data.length);
  const range = integerRanges[datatypeCode];
  for (let index = 0; index < data.length; index += 1) {
    let value = data[index];
    if (range) {
      value = value > 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
      value = Math.max(range[0], Math.min(range[1], value));
      if (value === 0) value = 0;
    }
    output[index] = value;
  }
  return output;
}

function assertDiagonalMapping(mapping, tolerance = 1e-5) {
  for (let row = 0; row < 3; row += 1) {
    for (let column = 0; column < 3; column += 1) {
      if (row !== column && Math.abs(mapping[row][column]) > tolerance) {
        throw new Error('Browser conforming currently requires an axis-aligned scan. Conform oblique images to 1 mm RAS before loading.');
      }
    }
  }
}

function multiply(left, right) {
  return left.map((row) => right[0].map((_, column) =>
    row.reduce((sum, value, index) => sum + value * right[index][column], 0)
  ));
}

function cleanZero(value) {
  return Math.abs(value) < 1e-14 ? 0 : value;
}
