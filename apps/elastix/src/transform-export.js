// Pure helpers for writing the registration transform as OME-Zarr (RFC-5).
// elastix itself evaluates the transform: transformix resamples a
// "coordinate image" whose voxels hold their own physical coordinate along
// one axis, and linear interpolation of a linear function is exact, so the
// result at each output point is that coordinate of T(point). A linear
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
export function coordinateRadius(images) {
  let reach = 1;
  for (const image of images) {
    const corners = 2 ** image.imageType.dimension;
    for (let corner = 0; corner < corners; corner += 1) {
      const index = Array.from(image.size, (size, axis) => ((corner >> axis) & 1) * (size - 1));
      for (const value of physicalPoint(image, index)) reach = Math.max(reach, Math.abs(value));
    }
  }
  return 2 ** Math.ceil(Math.log2(reach * 100));
}

/** Two voxels per axis spanning [-radius, radius], each holding its coordinate along `axis`. */
export function coordinateImage(dimension, axis, radius, componentType = "float64") {
  const Data = componentType === "float32" ? Float32Array : Float64Array;
  return {
    imageType: { dimension, componentType, pixelType: "Scalar", components: 1 },
    name: `coordinate-${axis}`,
    origin: Array(dimension).fill(-radius),
    spacing: Array(dimension).fill(2 * radius),
    direction: new Float64Array(dimension * dimension).map((_, index) => (index % (dimension + 1) === 0 ? 1 : 0)),
    size: Array(dimension).fill(2),
    metadata: new Map(),
    data: new Data(2 ** dimension).map((_, voxel) => ((voxel >> axis) & 1 ? radius : -radius)),
  };
}

/** The optimized maps, set to resample with linear interpolation, which keeps coordinate images exact. */
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

/** Least-squares affine q = M p + t, exact for an affine mapping sampled at its grid corners. */
export function fitAffine(points, mapped) {
  const dimension = points[0].length;
  const n = dimension + 1;
  const system = Array.from({ length: n }, () => Array(n + dimension).fill(0));
  points.forEach((point, k) => {
    const row = [...point, 1];
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) system[i][j] += row[i] * row[j];
      for (let j = 0; j < dimension; j += 1) system[i][n + j] += row[i] * mapped[k][j];
    }
  });
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) {
      if (Math.abs(system[row][column]) > Math.abs(system[pivot][column])) pivot = row;
    }
    [system[column], system[pivot]] = [system[pivot], system[column]];
    for (let row = 0; row < n; row += 1) {
      if (row === column) continue;
      const factor = system[row][column] / system[column][column];
      for (let j = column; j < n + dimension; j += 1) system[row][j] -= factor * system[column][j];
    }
  }
  const coefficient = (input, output) => system[input][n + output] / system[input][input];
  const matrix = Array.from({ length: dimension }, (_, row) => Array.from({ length: dimension }, (_, column) => coefficient(column, row)));
  const offset = Array.from({ length: dimension }, (_, row) => coefficient(dimension, row));
  let residual = 0;
  points.forEach((point, k) => {
    for (let row = 0; row < dimension; row += 1) {
      const value = matrix[row].reduce((sum, entry, column) => sum + entry * point[column], offset[row]);
      residual = Math.max(residual, Math.abs(value - mapped[k][row]));
    }
  });
  return { matrix, offset, residual };
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
