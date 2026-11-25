// A display mesh for a morphology: a tube of truncated cones along every section and a
// sphere at every soma sample, coloured by SWC type. Display only; no measurement reads it.

/** Okabe–Ito colours, distinguishable with the common colour-vision deficiencies. */
export const TYPE_COLORS = Object.freeze({
  1: [153, 153, 153, 255],
  2: [86, 180, 233, 255],
  3: [213, 94, 0, 255],
  4: [204, 121, 167, 255],
  other: [240, 228, 66, 255],
});

export const TYPE_LABELS = Object.freeze({ 1: "Soma", 2: "Axon", 3: "Basal dendrite", 4: "Apical dendrite", other: "Other type" });

/** Thin branches are drawn at least this fraction of the neuron's span wide. */
export const MIN_RADIUS_FRACTION = 0.002;

const SIDES = 8;

function sub(a, b) {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}
function perpendicular(t) {
  const axis = Math.abs(t[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  return normalize(cross(t, axis));
}

class MeshBuilder {
  constructor() {
    this.vertices = [];
    this.faces = [];
    this.colors = [];
  }
  vertex(p, color) {
    this.vertices.push(p[0], p[1], p[2]);
    this.colors.push(...color);
    return this.vertices.length / 3 - 1;
  }
  /** A tube through points [x, y, z, r], its rings carried by parallel transport. */
  tube(points, color, minRadius) {
    const tangents = points.map((_, k) => normalize(sub(points[Math.min(k + 1, points.length - 1)], points[Math.max(k - 1, 0)])));
    let last = tangents.find(Boolean);
    if (!last) return;
    for (let k = 0; k < tangents.length; k++) last = tangents[k] = tangents[k] ?? last;
    let normal = perpendicular(tangents[0]);
    let previous = -1;
    for (let k = 0; k < points.length; k++) {
      const t = tangents[k];
      const dot = normal[0] * t[0] + normal[1] * t[1] + normal[2] * t[2];
      normal = normalize([normal[0] - dot * t[0], normal[1] - dot * t[1], normal[2] - dot * t[2]]) ?? perpendicular(t);
      const binormal = cross(t, normal);
      const radius = Math.max(points[k][3], minRadius);
      const first = this.vertices.length / 3;
      for (let side = 0; side < SIDES; side++) {
        const theta = (2 * Math.PI * side) / SIDES;
        const [c, s] = [Math.cos(theta) * radius, Math.sin(theta) * radius];
        this.vertex([points[k][0] + c * normal[0] + s * binormal[0], points[k][1] + c * normal[1] + s * binormal[1], points[k][2] + c * normal[2] + s * binormal[2]], color);
      }
      if (previous >= 0) {
        for (let side = 0; side < SIDES; side++) {
          const next = (side + 1) % SIDES;
          this.faces.push(previous + side, previous + next, first + side, previous + next, first + next, first + side);
        }
      }
      previous = first;
    }
  }
  sphere(center, radius, color) {
    const rows = 6;
    const first = this.vertices.length / 3;
    for (let row = 0; row <= rows; row++) {
      const phi = (Math.PI * row) / rows;
      for (let side = 0; side < SIDES; side++) {
        const theta = (2 * Math.PI * side) / SIDES;
        this.vertex([
          center[0] + radius * Math.sin(phi) * Math.cos(theta),
          center[1] + radius * Math.sin(phi) * Math.sin(theta),
          center[2] + radius * Math.cos(phi),
        ], color);
      }
    }
    for (let row = 0; row < rows; row++) {
      for (let side = 0; side < SIDES; side++) {
        const a = first + row * SIDES + side;
        const b = first + row * SIDES + ((side + 1) % SIDES);
        this.faces.push(a, a + SIDES, b, b, a + SIDES, b + SIDES);
      }
    }
  }
}

/**
 * @param {import("./morphometrics.js").Morphology} morphology
 * @param {number} span the neuron's extent, for the minimum drawn radius
 * @returns {{ vertices: Float32Array, faces: Int32Array, colors: Uint8Array, types: number[] }}
 */
export function morphologyMesh(morphology, span) {
  const builder = new MeshBuilder();
  const minRadius = Math.max(span, 1) * MIN_RADIUS_FRACTION;
  const types = new Set();
  const colorOf = (type) => TYPE_COLORS[type] ?? TYPE_COLORS.other;
  for (const s of morphology.soma) {
    builder.sphere(s, Math.max(s[3], minRadius), colorOf(1));
    types.add(1);
  }
  for (const neurite of morphology.neurites) {
    for (const section of neurite.sections) {
      builder.tube(section.points, colorOf(section.type), minRadius);
      types.add(TYPE_COLORS[section.type] ? section.type : "other");
    }
  }
  return {
    vertices: Float32Array.from(builder.vertices),
    faces: Int32Array.from(builder.faces),
    colors: Uint8Array.from(builder.colors),
    types: [...types],
  };
}
