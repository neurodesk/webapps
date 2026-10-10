export const MuscleMapMonaiCompat = (() => {
  const ORIENTATION_TOLERANCE = 1e-6;

  function identity4() {
    return [
      new Float64Array([1, 0, 0, 0]),
      new Float64Array([0, 1, 0, 0]),
      new Float64Array([0, 0, 1, 0]),
      new Float64Array([0, 0, 0, 1])
    ];
  }

  function multiply4(left, right) {
    const result = identity4();
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) {
        let value = 0;
        for (let inner = 0; inner < 4; inner++) value += left[row][inner] * right[inner][column];
        result[row][column] = value;
      }
    }
    return result;
  }

  function solve4(left, right) {
    if (left.length !== 4 || right.length !== 4 || ![...left, ...right].every(row => row.length === 4 && Array.from(row).every(Number.isFinite))) {
      throw new Error('NIfTI affine must contain finite values');
    }
    const factors = left.map(row => Float64Array.from(row));
    const result = right.map(row => Float64Array.from(row));
    for (let column = 0; column < 4; column++) {
      let pivot = column;
      for (let row = column + 1; row < 4; row++) {
        if (Math.abs(factors[row][column]) > Math.abs(factors[pivot][column])) pivot = row;
      }
      if (Math.abs(factors[pivot][column]) < 1e-12) throw new Error('NIfTI affine is not invertible');
      if (pivot !== column) {
        [factors[pivot], factors[column]] = [factors[column], factors[pivot]];
        [result[pivot], result[column]] = [result[column], result[pivot]];
      }
      for (let row = column + 1; row < 4; row++) {
        factors[row][column] /= factors[column][column];
        for (let inner = column + 1; inner < 4; inner++) {
          factors[row][inner] -= factors[row][column] * factors[column][inner];
        }
      }
    }
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        for (let inner = 0; inner < row; inner++) result[row][column] -= factors[row][inner] * result[inner][column];
      }
      for (let row = 3; row >= 0; row--) {
        for (let inner = row + 1; inner < 4; inner++) result[row][column] -= factors[row][inner] * result[inner][column];
        result[row][column] /= factors[row][row];
      }
    }
    return result;
  }

  function invert4(matrix) {
    return solve4(matrix, identity4());
  }

  function transformPoint(matrix, point) {
    const input = [point[0], point[1], point[2], 1];
    const output = new Float64Array(4);
    for (let row = 0; row < 4; row++) {
      for (let column = 0; column < 4; column++) output[row] += matrix[row][column] * input[column];
    }
    return [output[0] / output[3], output[1] / output[3], output[2] / output[3]];
  }

  function affineSpacing(affine) {
    return [0, 1, 2].map(column => Math.hypot(
      affine[0][column], affine[1][column], affine[2][column]
    ));
  }

  function getOrientationTransform(affine) {
    const spacing = affineSpacing(affine);
    const directions = Array.from({ length: 3 }, (_, worldAxis) =>
      Array.from({ length: 3 }, (_, inputAxis) => affine[worldAxis][inputAxis] / spacing[inputAxis])
    );
    const permutations = [
      [0, 1, 2], [0, 2, 1], [1, 0, 2],
      [1, 2, 0], [2, 0, 1], [2, 1, 0]
    ];
    let perm = permutations[0];
    let bestScore = -Infinity;
    for (const candidate of permutations) {
      const score = Math.abs(directions[0][candidate[0]]) +
        Math.abs(directions[1][candidate[1]]) +
        Math.abs(directions[2][candidate[2]]);
      if (score > bestScore) {
        bestScore = score;
        perm = candidate;
      }
    }
    return {
      perm: [...perm],
      flip: perm.map((inputAxis, worldAxis) => directions[worldAxis][inputAxis] < 0)
    };
  }

  function orientationIndexTransform(dims, perm, flip) {
    const orientedDims = perm.map(inputAxis => dims[inputAxis]);
    const transform = identity4();
    for (let row = 0; row < 3; row++) transform[row].fill(0);
    for (let outputAxis = 0; outputAxis < 3; outputAxis++) {
      const inputAxis = perm[outputAxis];
      transform[inputAxis][outputAxis] = flip[outputAxis] ? -1 : 1;
      transform[inputAxis][3] = flip[outputAxis] ? orientedDims[outputAxis] - 1 : 0;
    }
    return { orientedDims, transform };
  }

  function orientToRAS(data, dims, affine) {
    const { perm, flip } = getOrientationTransform(affine);
    const { orientedDims, transform } = orientationIndexTransform(dims, perm, flip);
    const [nx, ny] = dims;
    const [dx, dy, dz] = orientedDims;
    const result = new Float32Array(dx * dy * dz);
    for (let oz = 0; oz < dz; oz++) {
      for (let oy = 0; oy < dy; oy++) {
        for (let ox = 0; ox < dx; ox++) {
          const coords = [ox, oy, oz];
          const source = [0, 0, 0];
          for (let axis = 0; axis < 3; axis++) {
            source[perm[axis]] = flip[axis] ? orientedDims[axis] - 1 - coords[axis] : coords[axis];
          }
          result[ox + oy * dx + oz * dx * dy] = data[source[0] + source[1] * nx + source[2] * nx * ny];
        }
      }
    }
    return {
      data: result,
      dims: orientedDims,
      affine: multiply4(affine, transform),
      perm,
      flip
    };
  }

  function roundHalfToEven(value) {
    const lower = Math.floor(value);
    const fraction = value - lower;
    if (fraction === 0.5) return lower % 2 === 0 ? lower : lower + 1;
    return Math.round(value);
  }

  function invert3(matrix) {
    const [a, b, c] = matrix[0];
    const [d, e, f] = matrix[1];
    const [g, h, i] = matrix[2];
    const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
    if (Math.abs(determinant) < 1e-12) throw new Error('NIfTI affine rotation is not invertible');
    return [
      [(e * i - f * h) / determinant, (c * h - b * i) / determinant, (b * f - c * e) / determinant],
      [(f * g - d * i) / determinant, (a * i - c * g) / determinant, (c * d - a * f) / determinant],
      [(d * h - e * g) / determinant, (b * g - a * h) / determinant, (a * e - b * d) / determinant]
    ];
  }

  function multiply3(left, right) {
    return Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (_, column) =>
        left[row].reduce((sum, value, inner) => sum + value * right[inner][column], 0)
      )
    );
  }

  function zoomAffine(affine, spacing) {
    const linear = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (_, column) => affine[row][column])
    );
    const gram = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (_, column) =>
        linear.reduce((sum, values) => sum + values[row] * values[column], 0)
      )
    );
    const lower = Array.from({ length: 3 }, () => [0, 0, 0]);
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column <= row; column++) {
        let value = gram[row][column];
        for (let inner = 0; inner < column; inner++) value -= lower[row][inner] * lower[column][inner];
        if (!Number.isFinite(value) || (row === column && value <= 0)) throw new Error('NIfTI affine rotation is not invertible');
        lower[row][column] = row === column ? Math.sqrt(value) : value / lower[column][column];
      }
    }
    const upper = Array.from({ length: 3 }, (_, row) =>
      Array.from({ length: 3 }, (_, column) => lower[column][row])
    );
    const rotation = multiply3(linear, invert3(upper));
    const output = identity4();
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) output[row][column] = rotation[row][column] * spacing[column];
    }
    return output;
  }

  function computeSpacingGeometry(dims, affine, targetSpacing) {
    const sourceSpacing = affineSpacing(affine);
    const actualTarget = targetSpacing.map((value, axis) => value > 0 ? value : sourceSpacing[axis]);
    const zeroOffsetAffine = zoomAffine(affine, actualTarget);
    const outputFromInput = solve4(zeroOffsetAffine, affine);
    const inputCorners = [];
    for (const x of [0, dims[0] - 1]) {
      for (const y of [0, dims[1] - 1]) {
        for (const z of [0, dims[2] - 1]) inputCorners.push([x, y, z]);
      }
    }
    const outputCorners = inputCorners.map(point => transformPoint(outputFromInput, point));
    const outputDims = [0, 1, 2].map(axis => {
      const values = outputCorners.map(point => point[axis]);
      return Math.max(1, roundHalfToEven(Math.max(...values) - Math.min(...values) + 1));
    });
    const worldCorners = inputCorners.map(point => transformPoint(affine, point));
    let offset = null;
    for (let corner = 0; corner < outputCorners.length; corner++) {
      const candidate = outputCorners[corner];
      const isMinimum = [0, 1, 2].every(axis => outputCorners.every(
        point => point[axis] >= candidate[axis] - 1e-8
      ));
      if (isMinimum) {
        offset = worldCorners[corner];
        break;
      }
    }
    if (!offset) {
      const inputCenter = transformPoint(affine, dims.map(value => value / 2));
      const outputCenter = transformPoint(zeroOffsetAffine, outputDims.map(value => value / 2));
      offset = inputCenter.map((value, axis) => value - outputCenter[axis]);
    }
    const outputAffine = zeroOffsetAffine;
    for (let axis = 0; axis < 3; axis++) outputAffine[axis][3] = offset[axis];
    return { dims: outputDims, affine: outputAffine, spacing: actualTarget };
  }

  function sampleTrilinearBorder(data, dims, x, y, z) {
    const [nx, ny, nz] = dims;
    const sx = Math.min(nx - 1, Math.max(0, x));
    const sy = Math.min(ny - 1, Math.max(0, y));
    const sz = Math.min(nz - 1, Math.max(0, z));
    const x0 = Math.floor(sx), x1 = Math.min(x0 + 1, nx - 1), wx = sx - x0;
    const y0 = Math.floor(sy), y1 = Math.min(y0 + 1, ny - 1), wy = sy - y0;
    const z0 = Math.floor(sz), z1 = Math.min(z0 + 1, nz - 1), wz = sz - z0;
    const plane = nx * ny;
    const c000 = data[x0 + y0 * nx + z0 * plane];
    const c100 = data[x1 + y0 * nx + z0 * plane];
    const c010 = data[x0 + y1 * nx + z0 * plane];
    const c110 = data[x1 + y1 * nx + z0 * plane];
    const c001 = data[x0 + y0 * nx + z1 * plane];
    const c101 = data[x1 + y0 * nx + z1 * plane];
    const c011 = data[x0 + y1 * nx + z1 * plane];
    const c111 = data[x1 + y1 * nx + z1 * plane];
    // PyTorch's tensor axes are reversed, so its eight corners advance z first.
    let value = c000 * ((1 - wz) * (1 - wy) * (1 - wx));
    value += c001 * (wz * (1 - wy) * (1 - wx));
    value += c010 * ((1 - wz) * wy * (1 - wx));
    value += c011 * (wz * wy * (1 - wx));
    value += c100 * ((1 - wz) * (1 - wy) * wx);
    value += c101 * (wz * (1 - wy) * wx);
    value += c110 * ((1 - wz) * wy * wx);
    value += c111 * (wz * wy * wx);
    return value;
  }

  function createTorchGridTransform(sourceAffine, sourceDims, outputAffine, outputDims) {
    const sourceFromOutput = solve4(sourceAffine, outputAffine);
    const normalizeSource = identity4();
    const denormalizeOutput = identity4();
    for (let axis = 0; axis < 3; axis++) {
      normalizeSource[axis][axis] = 2 / sourceDims[axis];
      normalizeSource[axis][3] = 1 / sourceDims[axis] - 1;
      const scale = 2 / outputDims[axis];
      denormalizeOutput[axis][axis] = 1 / scale;
      denormalizeOutput[axis][3] = -(1 / outputDims[axis] - 1) * denormalizeOutput[axis][axis];
    }
    const normalized = multiply4(
      multiply4(normalizeSource, sourceFromOutput),
      denormalizeOutput
    );
    const reversed = identity4();
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) reversed[row][column] = normalized[2 - row][2 - column];
      reversed[row][3] = normalized[2 - row][3];
    }
    return reversed;
  }

  const gridAxes = new WeakMap();

  function createTorchAxis(size) {
    const axis = new Float64Array(size);
    if (size === 1) return axis;
    const bits = new DataView(new ArrayBuffer(8));
    bits.setFloat64(0, 2 / (size - 1));
    const raw = bits.getBigUint64(0);
    const exponent = Number((raw >> 52n) & 2047n) - 1023 - 52;
    const significand = (raw & ((1n << 52n) - 1n)) | (1n << 52n);
    const one = 1n << BigInt(-exponent);
    for (let index = 0; index < size; index++) {
      // Round the fused linspace expression once, before exact power-of-two scaling.
      const numerator = index < Math.floor(size / 2)
        ? BigInt(index) * significand - one
        : one - BigInt(size - index - 1) * significand;
      axis[index] = Number(numerator) * 2 ** exponent * (size - 1) / size;
    }
    return axis;
  }

  function torchGridSourcePoint(transform, outputPoint, sourceDims, outputDims) {
    let grid = gridAxes.get(transform);
    if (!grid || grid.dims.some((size, axis) => size !== outputDims[axis])) {
      grid = { dims: [...outputDims], axes: outputDims.map(createTorchAxis) };
      gridAxes.set(transform, grid);
    }
    const normalizedOutput = [2, 1, 0].map(axis => grid.axes[axis][outputPoint[axis]]);
    const normalizedSource = [0, 1, 2].map(row => {
      let value = 0;
      for (let column = 0; column < 3; column++) {
        value += transform[row][column] * normalizedOutput[column];
      }
      return value + transform[row][3];
    });
    const sourceReversed = normalizedSource.map((coordinate, axis) => {
      const size = sourceDims[2 - axis];
      return ((coordinate + 1) * size - 1) / 2;
    });
    return [sourceReversed[2], sourceReversed[1], sourceReversed[0]];
  }

  function resampleVolume(data, dims, affine, targetSpacing) {
    if (dims.length !== 3 || !dims.every(size => Number.isSafeInteger(size) && size > 0 && size <= 0xffffffff) ||
        data.length !== dims.reduce((count, size) => count * size, 1)) {
      throw new Error('Volume dimensions must match the input data');
    }
    const geometry = computeSpacingGeometry(dims, affine, targetSpacing);
    const unchanged = dims.every((size, axis) => size === geometry.dims[axis]) &&
      affine.every((row, i) => Array.from(row).every((value, j) =>
        Math.abs(value - geometry.affine[i][j]) <= 1e-3 + 1e-5 * Math.abs(geometry.affine[i][j])));
    if (unchanged) return { data: Float32Array.from(data), ...geometry, affine };
    const gridTransform = createTorchGridTransform(affine, dims, geometry.affine, geometry.dims);
    const [nx, ny, nz] = geometry.dims;
    const result = new Float32Array(nx * ny * nz);
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const source = torchGridSourcePoint(gridTransform, [x, y, z], dims, geometry.dims);
          result[x + y * nx + z * nx * ny] = sampleTrilinearBorder(data, dims, ...source);
        }
      }
    }
    return { data: result, ...geometry };
  }

  function connectedComponents3D6(binaryMask, dims) {
    const [nx, ny, nz] = dims;
    const labels = new Int32Array(nx * ny * nz);
    const parent = [0];
    const rank = [0];
    let nextLabel = 1;
    function find(value) {
      while (parent[value] !== value) {
        parent[value] = parent[parent[value]];
        value = parent[value];
      }
      return value;
    }
    function union(left, right) {
      left = find(left);
      right = find(right);
      if (left === right) return;
      if (rank[left] < rank[right]) [left, right] = [right, left];
      parent[right] = left;
      if (rank[left] === rank[right]) rank[left]++;
    }
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const index = x + y * nx + z * nx * ny;
          if (!binaryMask[index]) continue;
          const neighbors = [];
          if (x > 0 && labels[index - 1]) neighbors.push(labels[index - 1]);
          if (y > 0 && labels[index - nx]) neighbors.push(labels[index - nx]);
          if (z > 0 && labels[index - nx * ny]) neighbors.push(labels[index - nx * ny]);
          if (!neighbors.length) {
            labels[index] = nextLabel;
            parent.push(nextLabel);
            rank.push(0);
            nextLabel++;
          } else {
            labels[index] = neighbors[0];
            for (let neighbor = 1; neighbor < neighbors.length; neighbor++) union(labels[index], neighbors[neighbor]);
          }
        }
      }
    }
    const canonical = new Map();
    let numComponents = 0;
    for (let index = 0; index < labels.length; index++) {
      if (!labels[index]) continue;
      const rootLabel = find(labels[index]);
      if (!canonical.has(rootLabel)) canonical.set(rootLabel, ++numComponents);
      labels[index] = canonical.get(rootLabel);
    }
    return { labels, numComponents };
  }

  return {
    affineSpacing,
    computeSpacingGeometry,
    connectedComponents3D6,
    createTorchGridTransform,
    getOrientationTransform,
    identity4,
    invert4,
    multiply4,
    orientToRAS,
    orientationIndexTransform,
    resampleVolume,
    torchGridSourcePoint,
    transformPoint,
    ORIENTATION_TOLERANCE
  };
})();
