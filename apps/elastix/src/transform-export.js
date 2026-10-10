// Pure helpers for writing the registration transform as OME-Zarr (RFC-5).
// elastix itself evaluates the transform: transformix resamples a
// "coordinate image" whose voxels hold their own physical coordinate along
// one axis. Linear interpolation recovers that coordinate of T(point) to
// the sampler's precision. A linear
// transform is then fitted exactly from the stationary image's corners; any
// other is sampled at every stationary voxel as a displacement field. No DOM
// or ITK-Wasm imports, so Node tests exercise it directly.

// ITK parameterizations that are affine maps. Anything else (B-spline,
// displacement and velocity fields) is written as a displacement field.
const LINEAR = new Set([
  "Composite",
  "Identity",
  "Translation",
  "Euler2D",
  "Euler3D",
  "Rigid2D",
  "Rigid3D",
  "Versor",
  "VersorRigid3D",
  "Scale",
  "ScaleLogarithmic",
  "ScaleSkewVersor3D",
  "Similarity2D",
  "Similarity3D",
  "QuaternionRigid",
  "Affine",
  "ScalableAffine",
]);

export function isLinearTransform(transformList) {
  return transformList.every((transform) => LINEAR.has(transform.transformType.transformParameterization));
}

/** RFC-5 spatial axis names, in Zarr order, for an image of this dimension. */
export function spatialDims(dimension) {
  return ["z", "y", "x"].slice(3 - dimension);
}

function directionColumn(image, axis) {
  const dimension = image.imageType.dimension;
  return Array.from({ length: dimension }, (_, row) => image.direction[row * dimension + axis]);
}

/** Physical point of a continuous index on an ITK image grid: origin + D·(spacing ∘ index). */
export function physicalPoint(image, index) {
  const dimension = image.imageType.dimension;
  const point = Array.from(image.origin);
  for (let axis = 0; axis < dimension; axis += 1) {
    const column = directionColumn(image, axis);
    for (let row = 0; row < dimension; row += 1) point[row] += column[row] * image.spacing[axis] * index[axis];
  }
  return point;
}

/**
 * Half-width of a coordinate image that contains every point the transform
 * can reach: a power of two, so its corner values stay exact in float32.
 */
export function coordinateRadius(images, center = []) {
  let reach = 1;
  for (const image of images) {
    const corners = 2 ** image.imageType.dimension;
    for (let corner = 0; corner < corners; corner += 1) {
      const index = Array.from(image.size, (size, axis) => ((corner >> axis) & 1) * (size - 1));
      physicalPoint(image, index).forEach((value, axis) => { reach = Math.max(reach, Math.abs(value - (center[axis] ?? 0))); });
    }
  }
  return 2 ** Math.ceil(Math.log2(reach * 100));
}

/** Two voxels per axis around `center`, holding the coordinate minus its center along `axis`. */
export function coordinateImage(dimension, axis, radius, componentType = "float64", center = Array(dimension).fill(0)) {
  const Data = componentType === "float32" ? Float32Array : Float64Array;
  return {
    imageType: { dimension, componentType, pixelType: "Scalar", components: 1 },
    name: `coordinate-${axis}`,
    origin: center.map((value) => value - radius),
    spacing: Array(dimension).fill(2 * radius),
    direction: new Float64Array(dimension * dimension).map((_, index) => (index % (dimension + 1) === 0 ? 1 : 0)),
    size: Array(dimension).fill(2),
    metadata: new Map(),
    data: new Data(2 ** dimension).map((_, voxel) => ((voxel >> axis) & 1 ? radius : -radius)),
  };
}

/** The optimized maps, set to resample with linear interpolation, without altering the optimized maps. */
export function coordinateParameterObject(transformParameterObject) {
  return transformParameterObject.map((map) => ({
    ...map,
    ResampleInterpolator: ["FinalLinearInterpolator"],
    DefaultPixelValue: ["0"],
  }));
}

/** A transformix output grid of the image's corners (2 points per axis) and their physical points. */
export function cornerGrid(image) {
  const dimension = image.imageType.dimension;
  const outputSpacing = Array.from(image.size, (size, axis) => Math.max(size - 1, 1) * image.spacing[axis]);
  const points = Array.from({ length: 2 ** dimension }, (_, corner) => physicalPoint(
    image,
    Array.from(image.size, (size, axis) => ((corner >> axis) & 1) * Math.max(size - 1, 1)),
  ));
  return {
    grid: {
      outputOrigin: Array.from(image.origin),
      outputSpacing,
      outputSize: Array(dimension).fill(2),
      outputDirection: Array.from(image.direction),
    },
    points,
  };
}

/** Least-squares affine q = M p + t, solved by QR on centered, scaled coordinates. */
export function fitAffine(points, mapped) {
  const dimension = points[0]?.length;
  if (![2, 3].includes(dimension) || points.length < dimension + 1 || mapped.length !== points.length
    || [...points, ...mapped].some((point) => point.length !== dimension || !point.every(Number.isFinite))) {
    throw new Error("Cannot export an affine from invalid corner coordinates.");
  }
  const center = (values) => values[0].map((first, axis) => first
    + values.reduce((sum, point) => sum + (point[axis] - first), 0) / values.length);
  const inputCenter = center(points);
  const outputCenter = center(mapped);
  const scales = inputCenter.map((value, axis) => Math.max(...points.map((point) => Math.abs(point[axis] - value))));
  if (scales.some((value) => !Number.isFinite(value) || value === 0)) {
    throw new Error("Cannot export an affine from a degenerate corner grid.");
  }
  const system = points.map((point, k) => [
    ...point.map((value, axis) => (value - inputCenter[axis]) / scales[axis]),
    ...mapped[k].map((value, axis) => value - outputCenter[axis]),
  ]);
  // Householder QR avoids squaring the grid's condition number.
  for (let column = 0; column < dimension; column += 1) {
    const norm = Math.hypot(...system.slice(column).map((row) => row[column]));
    if (!Number.isFinite(norm) || norm <= 64 * Number.EPSILON * points.length) {
      throw new Error("Cannot export an affine from a degenerate corner grid.");
    }
    const diagonal = system[column][column] < 0 ? norm : -norm;
    const vector = system.slice(column).map((row) => row[column]);
    vector[0] -= diagonal;
    const vectorNorm = Math.hypot(...vector);
    const unit = vector.map((value) => value / vectorNorm);
    for (let j = column; j < 2 * dimension; j += 1) {
      const projection = unit.reduce((sum, value, i) => sum + value * system[column + i][j], 0);
      unit.forEach((value, i) => { system[column + i][j] -= 2 * value * projection; });
    }
    system[column][column] = diagonal;
  }
  const matrix = Array.from({ length: dimension }, (_, output) => {
    const coefficients = Array(dimension).fill(0);
    for (let row = dimension - 1; row >= 0; row -= 1) {
      let value = system[row][dimension + output];
      for (let column = row + 1; column < dimension; column += 1) value -= system[row][column] * coefficients[column];
      coefficients[row] = value / system[row][row];
    }
    return coefficients.map((value, axis) => value / scales[axis]);
  });
  const offset = outputCenter.map((value, row) => value
    - matrix[row].reduce((sum, entry, column) => sum + entry * inputCenter[column], 0));
  let residual = 0;
  points.forEach((point, k) => {
    for (let row = 0; row < dimension; row += 1) {
      const value = matrix[row].reduce((sum, entry, column) => sum + entry * point[column], offset[row]);
      residual = Math.max(residual, Math.abs(value - mapped[k][row]));
    }
  });
  const fit = { matrix, offset, residual };
  assertAffineFit(fit, Infinity);
  return fit;
}

/** Reject invalid or inaccurate coefficients before serializing an RFC-5 affine. */
export function assertAffineFit({ matrix, offset, residual }, tolerance) {
  if (![...matrix.flat(), ...offset, residual].every(Number.isFinite) || residual > tolerance) {
    throw new Error(`Cannot export an accurate finite affine transform from the mapped corners (error ${residual}, limit ${tolerance}).`);
  }
}

/** An ITK-Wasm Affine transform (centre at the origin) for a matrix and offset. */
export function affineTransform(matrix, offset) {
  const dimension = offset.length;
  return {
    transformType: { transformParameterization: "Affine", parametersValueType: "float64", inputDimension: dimension, outputDimension: dimension },
    numberOfParameters: dimension * dimension + dimension,
    numberOfFixedParameters: dimension,
    name: "",
    inputSpaceName: "",
    outputSpaceName: "",
    parameters: new Float64Array([...matrix.flat(), ...offset]),
    fixedParameters: new Float64Array(dimension),
  };
}

/**
 * The displacement T(p) - p at every voxel of the image grid (x fastest), as
 * an interleaved float32 vector field, from transformix's mapped coordinates.
 */
export function displacementVectors(mapped, image) {
  const dimension = image.imageType.dimension;
  const size = Array.from(image.size);
  const count = size.reduce((a, b) => a * b, 1);
  const vectors = new Float32Array(count * dimension);
  const index = Array(dimension).fill(0);
  for (let voxel = 0; voxel < count; voxel += 1) {
    const point = physicalPoint(image, index);
    for (let axis = 0; axis < dimension; axis += 1) vectors[voxel * dimension + axis] = mapped[axis][voxel] - point[axis];
    for (let axis = 0; axis < dimension; axis += 1) {
      index[axis] += 1;
      if (index[axis] < size[axis]) break;
      index[axis] = 0;
    }
  }
  return vectors;
}

/** The ITK-Wasm vector image that holds a displacement field on the image's grid. */
export function displacementFieldImage(vectors, image) {
  const dimension = image.imageType.dimension;
  return {
    imageType: { dimension, componentType: "float32", pixelType: "Vector", components: dimension },
    name: "displacements",
    origin: Array.from(image.origin),
    spacing: Array.from(image.spacing),
    direction: new Float64Array(image.direction),
    size: Array.from(image.size),
    metadata: new Map(),
    data: vectors,
  };
}

/** The transformation as the store's only one: from the stationary (fixed) image to the moving one. */
export function namedTransformation(transformation) {
  return { ...transformation, name: "fixed_to_moving", input: { name: "fixed" }, output: { name: "moving" } };
}
