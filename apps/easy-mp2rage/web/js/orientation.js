const permutations = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
];

// Choose the nearest anatomical axes for native slices; do not resample data.
export function anatomicalGrid(dims, affine) {
  const spacing = [0, 1, 2].map(axis =>
    Math.hypot(affine[axis], affine[4 + axis], affine[8 + axis])
  );
  const score = axes => axes.reduce((sum, axis, world) =>
    sum + Math.abs(affine[world * 4 + axis]) / spacing[axis], 0
  );
  const axes = permutations.reduce((best, candidate) =>
    score(candidate) > score(best) ? candidate : best
  );
  const strides = [1, dims[0], dims[0] * dims[1]];
  const steps = axes.map((axis, world) =>
    (affine[world * 4 + axis] < 0 ? -1 : 1) * strides[axis]
  );
  const origin = axes.reduce((offset, axis, world) =>
    offset + (steps[world] < 0 ? (dims[axis] - 1) * strides[axis] : 0), 0
  );
  return {
    dims: axes.map(axis => dims[axis]),
    index: (right, anterior, superior) =>
      origin + right * steps[0] + anterior * steps[1] + superior * steps[2],
  };
}
