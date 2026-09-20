import { writeMz3 } from './results.js';
export { surfaceNormals } from './patches.js';

// Greedy spatial sampling keeps glyphs separated in scanner RAS, including across folds.
export function normalArrows({ middle, normals }, { spacing, length }) {
  if (!Number.isFinite(spacing) || spacing < 2 || !Number.isFinite(length) || length < 0.5 || length > 10) {
    throw new Error('Normal arrows require spacing ≥ 2 mm and length between 0.5 and 10 mm.');
  }
  const cells = new Map();
  const selected = [];
  const vertices = [];
  const faces = [];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  for (let i = 0; i < middle.length; i += 3) {
    const p = Array.from(middle.subarray(i, i + 3));
    const cell = p.map((v) => Math.floor(v / spacing));
    let nearby = false;
    for (let x = -1; x <= 1 && !nearby; x += 1) {
      for (let y = -1; y <= 1 && !nearby; y += 1) {
        for (let z = -1; z <= 1 && !nearby; z += 1) {
          for (const q of cells.get([cell[0] + x, cell[1] + y, cell[2] + z].join(',')) || []) {
            if (Math.hypot(...p.map((v, axis) => v - q[axis])) < spacing) nearby = true;
          }
        }
      }
    }
    if (nearby) continue;
    const key = cell.join(',');
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(p);
    selected.push(i / 3);
    const n = Array.from(normals.subarray(i, i + 3));
    const tangent = cross(n, Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]);
    const u = tangent.map((v) => v / Math.hypot(...tangent));
    const v = cross(n, u);
    const base = vertices.length / 3;
    const radius = Math.min(0.25, length * 0.1);
    for (const [distance, width] of [[0, radius], [length * 0.7, radius], [length * 0.7, radius * 2.5]]) {
      for (let side = 0; side < 6; side += 1) {
        const angle = side * Math.PI / 3;
        vertices.push(...p.map((value, axis) => value + n[axis] * distance + width * (u[axis] * Math.cos(angle) + v[axis] * Math.sin(angle))));
      }
    }
    vertices.push(...p.map((value, axis) => value + n[axis] * length));
    for (let side = 0; side < 6; side += 1) {
      const next = (side + 1) % 6;
      faces.push(base + side, base + next, base + side + 6, base + next, base + next + 6, base + side + 6);
      faces.push(base + side + 12, base + next + 12, base + 18);
    }
  }
  return { bytes: writeMz3(vertices, faces), count: selected.length, indices: selected };
}
