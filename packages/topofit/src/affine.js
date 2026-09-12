import { applyAffine, inverseAffine } from './volume.js';

const MNI305_TO_MNI152 = [
  [0.9975, -0.0073, 0.0176, -0.0429],
  [0.0146, 1.00090003, -0.0024, 1.54960001],
  [-0.013, -0.0093, 0.9971, 1.18400002],
  [0, 0, 0, 1],
];

export function estimateBrainAffine(targets, weights, templates) {
  const normal = Array.from({ length: 4 }, () => new Float64Array(4));
  const right = Array.from({ length: 4 }, () => new Float64Array(4));
  const count = templates.length / 3;
  for (let point = 0; point < count; point += 1) {
    const weight = weights[point];
    const a = [
      templates[point * 3] * weight,
      templates[point * 3 + 1] * weight,
      templates[point * 3 + 2] * weight,
      weight,
    ];
    const b = [
      targets[point * 3] * weight,
      targets[point * 3 + 1] * weight,
      targets[point * 3 + 2] * weight,
      weight,
    ];
    for (let row = 0; row < 4; row += 1) {
      for (let column = 0; column < 4; column += 1) {
        normal[row][column] += a[row] * a[column];
        right[row][column] += a[row] * b[column];
      }
    }
  }
  const solution = solve(normal, right);
  return Array.from({ length: 4 }, (_, row) => Array.from({ length: 4 }, (_, column) => solution[column][row]));
}

export function prepareTemplates(affine, voxelToRas, templates) {
  const transform = multiply(inverseAffine(voxelToRas), affine);
  const subject = applyAffine(transform, templates);
  const half = subject.length / 2;
  return { left: subject.slice(0, half), right: subject.slice(half) };
}

export function mni305ToMni152() {
  return MNI305_TO_MNI152.map((row) => [...row]);
}

export function multiply(left, right) {
  return left.map((row) =>
    right[0].map((_, column) => row.reduce((total, value, index) => total + value * right[index][column], 0)),
  );
}

function solve(left, right) {
  const rows = left.map((row, index) => [...row, ...right[index]]);
  for (let column = 0; column < 4; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 4; row += 1) {
      if (Math.abs(rows[row][column]) > Math.abs(rows[pivot][column])) pivot = row;
    }
    if (Math.abs(rows[pivot][column]) < 1e-12) throw new Error('TReGA produced a rank-deficient affine fit.');
    [rows[column], rows[pivot]] = [rows[pivot], rows[column]];
    const divisor = rows[column][column];
    for (let entry = column; entry < 8; entry += 1) rows[column][entry] /= divisor;
    for (let row = 0; row < 4; row += 1) {
      if (row === column) continue;
      const factor = rows[row][column];
      for (let entry = column; entry < 8; entry += 1) rows[row][entry] -= factor * rows[column][entry];
    }
  }
  return rows.map((row) => row.slice(4));
}
