// 4 × 4 homogeneous matrices as arrays of four rows, and Greedy's matrix text.

export const identity = () => [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];

export function multiply(a, b) {
  return a.map((row) => [0, 1, 2, 3].map((c) => row[0] * b[0][c] + row[1] * b[1][c] + row[2] * b[2][c] + row[3] * b[3][c]));
}

export function apply(m, [x, y, z]) {
  return [0, 1, 2].map((r) => m[r][0] * x + m[r][1] * y + m[r][2] * z + m[r][3]);
}

/** The linear part only (a direction or displacement). */
export function applyLinear(m, [x, y, z]) {
  return [0, 1, 2].map((r) => m[r][0] * x + m[r][1] * y + m[r][2] * z);
}

export function invert(m) {
  const [[a, b, c, tx], [d, e, f, ty], [g, h, k, tz]] = m;
  const det = a * (e * k - f * h) - b * (d * k - f * g) + c * (d * h - e * g);
  if (!Number.isFinite(det) || Math.abs(det) < 1e-300) throw new Error('The matrix is singular.');
  const r = [
    [(e * k - f * h) / det, (c * h - b * k) / det, (b * f - c * e) / det],
    [(f * g - d * k) / det, (a * k - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
  return [
    [...r[0], -(r[0][0] * tx + r[0][1] * ty + r[0][2] * tz)],
    [...r[1], -(r[1][0] * tx + r[1][1] * ty + r[1][2] * tz)],
    [...r[2], -(r[2][0] * tx + r[2][1] * ty + r[2][2] * tz)],
    [0, 0, 0, 1],
  ];
}

/** Greedy's RAS matrix text (`-o affine.mat`): four rows of four numbers. */
export function parseMatrix(text) {
  const rows = String(text).trim().split(/\n+/).map((line) => line.trim().split(/\s+/).map(Number));
  if (rows.length !== 4 || rows.some((row) => row.length !== 4 || row.some((value) => !Number.isFinite(value)))) {
    throw new Error('A Greedy matrix has four rows of four numbers.');
  }
  return rows;
}

export function formatMatrix(m) {
  return `${m.map((row) => row.map((value) => String(value)).join(' ')).join('\n')}\n`;
}

/**
 * The in-plane part of a matrix in a plane's local frame (z along the normal): z neither feeds
 * nor receives x and y, and keeps its value. Greedy registers a section as a thin 3-D image,
 * and the terms that move it out of its plane are unconstrained there.
 */
export function inPlane(m) {
  return [
    [m[0][0], m[0][1], 0, m[0][3]],
    [m[1][0], m[1][1], 0, m[1][3]],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

/** The 2-D rotation and translation nearest a local-frame rigid matrix (its in-plane rotation angle). */
export function inPlaneRigid(m) {
  const angle = Math.atan2(m[1][0] - m[0][1], m[0][0] + m[1][1]);
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [[c, -s, 0, m[0][3]], [s, c, 0, m[1][3]], [0, 0, 1, 0], [0, 0, 0, 1]];
}
