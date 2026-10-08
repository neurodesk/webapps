import { test } from "node:test";
import assert from "node:assert/strict";
import {
  affineTransform,
  coordinateImage,
  coordinateParameterObject,
  coordinateRadius,
  cornerGrid,
  displacementFieldImage,
  displacementVectors,
  fitAffine,
  isLinearTransform,
  namedTransformation,
  physicalPoint,
  spatialDims,
} from "../src/transform-export.js";

const stage = (transformParameterization) => ({ transformType: { transformParameterization } });

// A 3D grid flipped on x and y, as ITK reads a radiological-convention NIfTI.
const image = {
  imageType: { dimension: 3, componentType: "float32", pixelType: "Scalar", components: 1 },
  origin: [90, 126, -72],
  spacing: [2, 2, 2.5],
  direction: new Float64Array([-1, 0, 0, 0, -1, 0, 0, 0, 1]),
  size: [4, 3, 2],
};

test("only stacks of affine-type stages are written as one affine", () => {
  assert.equal(isLinearTransform(["Composite", "Affine", "Euler3D", "Translation"].map(stage)), true);
  assert.equal(isLinearTransform(["Composite", "Similarity2D"].map(stage)), true);
  assert.equal(isLinearTransform(["Composite", "BSpline", "Affine"].map(stage)), false);
  assert.equal(isLinearTransform(["DisplacementField"].map(stage)), false);
  assert.deepEqual(spatialDims(3), ["z", "y", "x"]);
  assert.deepEqual(spatialDims(2), ["y", "x"]);
});

test("physical points follow the direction matrix", () => {
  assert.deepEqual(physicalPoint(image, [0, 0, 0]), [90, 126, -72]);
  assert.deepEqual(physicalPoint(image, [1, 2, 1]), [88, 122, -69.5]);
});

test("the coordinate image holds each voxel's coordinate and spans every reachable point", () => {
  const radius = coordinateRadius([image]);
  assert.equal(Math.log2(radius) % 1, 0, "a power of two keeps the corners exact in float32");
  assert.ok(radius >= 100 * 126);
  const coordinates = coordinateImage(3, 2, radius);
  assert.deepEqual(coordinates.size, [2, 2, 2]);
  assert.deepEqual(coordinates.origin, [-radius, -radius, -radius]);
  // Voxel index (x, y, z) = (1, 0, 1) is element 1 + 4 = 5; its z coordinate is +radius.
  assert.equal(coordinates.data[5], radius);
  assert.equal(coordinates.data[1], -radius);
  assert.ok(coordinateImage(2, 0, 8, "float32").data instanceof Float32Array);
});

test("coordinate maps resample linearly and leave the optimized maps untouched", () => {
  const optimized = [{ Transform: ["AffineTransform"], ResampleInterpolator: ["FinalBSplineInterpolator"], Size: ["4", "3", "2"] }];
  const [map] = coordinateParameterObject(optimized);
  assert.deepEqual(map.ResampleInterpolator, ["FinalLinearInterpolator"]);
  assert.deepEqual(map.Size, ["4", "3", "2"]);
  assert.deepEqual(optimized[0].ResampleInterpolator, ["FinalBSplineInterpolator"]);
});

// What transformix returns for a coordinate image: T(point) along each axis.
function simulateTransformix(points, map) {
  return [0, 1, 2].map((axis) => points.map((point) => map(point)[axis]));
}

test("an affine is recovered exactly from transformix's mapping of the grid corners", () => {
  const angle = 0.2;
  const matrix = [[Math.cos(angle), -Math.sin(angle), 0.05], [Math.sin(angle), Math.cos(angle), 0], [0, 0.1, 1.2]];
  const offset = [3, -7, 11];
  const map = (p) => matrix.map((row, i) => row.reduce((sum, value, j) => sum + value * p[j], offset[i]));
  const { grid, points } = cornerGrid(image);
  assert.deepEqual(grid.outputSize, [2, 2, 2]);
  assert.deepEqual(grid.outputSpacing, [6, 4, 2.5]);
  assert.deepEqual(points[7], physicalPoint(image, [3, 2, 1]));
  const mapped = simulateTransformix(points, map);
  const fitted = fitAffine(points, points.map((_, corner) => mapped.map((axis) => axis[corner])));
  assert.ok(fitted.residual < 1e-9);
  fitted.matrix.flat().forEach((value, index) => assert.ok(Math.abs(value - matrix.flat()[index]) < 1e-9));
  fitted.offset.forEach((value, index) => assert.ok(Math.abs(value - offset[index]) < 1e-9));
  const itk = affineTransform(fitted.matrix, fitted.offset);
  assert.equal(itk.transformType.transformParameterization, "Affine");
  assert.equal(itk.parameters.length, 12);
  assert.deepEqual(Array.from(itk.fixedParameters), [0, 0, 0]);
});

test("displacements are T(p) - p at every voxel, x fastest, components interleaved", () => {
  const shift = [1.5, -2, 0.25];
  const count = 4 * 3 * 2;
  const points = Array.from({ length: count }, (_, voxel) => physicalPoint(image, [voxel % 4, Math.floor(voxel / 4) % 3, Math.floor(voxel / 12)]));
  const mapped = simulateTransformix(points, (p) => p.map((value, axis) => value + shift[axis]));
  const vectors = displacementVectors(mapped, image);
  assert.equal(vectors.length, count * 3);
  for (let voxel = 0; voxel < count; voxel += 1) {
    shift.forEach((value, axis) => assert.ok(Math.abs(vectors[voxel * 3 + axis] - value) < 1e-5));
  }
  const field = displacementFieldImage(vectors, image);
  assert.deepEqual(field.imageType, { dimension: 3, componentType: "float32", pixelType: "Vector", components: 3 });
  assert.deepEqual(field.size, image.size);
  assert.equal(field.data, vectors);
});

test("the stored transformation runs from the fixed to the moving coordinate system", () => {
  assert.deepEqual(namedTransformation({ type: "affine", affine: [[1, 0, 0]] }), {
    type: "affine",
    affine: [[1, 0, 0]],
    name: "fixed_to_moving",
    input: { name: "fixed" },
    output: { name: "moving" },
  });
});
