// Morphometrics of an SWC tree, defined as NeuroM 4 defines them (see README.md,
// "Definitions"). Pure: samples from readSwc in, numbers out. Distances are in the
// file's units (µm for NeuroMorpho.Org), angles in radians.
import { SOMA } from "./swc.js";

export const NEURITE_TYPES = Object.freeze({ all: null, axon: 2, basal: 3, apical: 4 });

/**
 * A section is an unbranched run of points. Like MorphIO, a child section starts with
 * its parent's last point, and a neurite's first section starts at its first sample,
 * so the gap between the soma and a neurite is not part of any section.
 * @typedef {{ type: number, points: number[][], children: Section[], branchOrder: number, pathEnd: number, length: number }} Section
 * @typedef {{ type: number, root: Section, sections: Section[] }} Neurite
 * @typedef {{ center: number[], soma: number[][], neurites: Neurite[] }} Morphology
 */

const point = (s) => [s.x, s.y, s.z, s.r];

function distance(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** The angle at `origin` between `a` and `b`, computed as NeuroM's angle_3points does. */
export function angle(origin, a, b) {
  const u = [a[0] - origin[0], a[1] - origin[1], a[2] - origin[2]];
  const v = [b[0] - origin[0], b[1] - origin[1], b[2] - origin[2]];
  const cross = Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]);
  return Math.atan2(cross, u[0] * v[0] + u[1] * v[1] + u[2] * v[2]);
}

/**
 * Build the soma and neurites. The soma is every type-1 sample reached from a type-1
 * root through type-1 parents; its first sample is the centre, as NeuroM takes it for
 * SWC somata. A type-1 sample inside a neurite takes its parent's type.
 * @param {import("./swc.js").Sample[]} samples parents first
 * @returns {Morphology}
 */
export function buildMorphology(samples) {
  const byId = new Map(samples.map((s) => [s.id, s]));
  const kind = new Map();
  for (const s of samples) {
    const parent = byId.get(s.parent);
    const parentKind = parent ? kind.get(parent.id) : null;
    if (s.type === SOMA && (!parent || parentKind === SOMA)) kind.set(s.id, SOMA);
    else if (s.type === SOMA) kind.set(s.id, parentKind);
    else kind.set(s.id, s.type);
  }
  const children = new Map();
  const roots = [];
  for (const s of samples) {
    if (kind.get(s.id) === SOMA) continue;
    const parent = byId.get(s.parent);
    if (!parent || kind.get(parent.id) === SOMA) {
      roots.push(s);
      continue;
    }
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(s);
  }
  const soma = samples.filter((s) => kind.get(s.id) === SOMA).map(point);
  const center = (soma[0] ?? point(samples[0])).slice(0, 3);

  const neurites = roots.map((root) => {
    const sections = [];
    const grow = (first, start, branchOrder, pathStart) => {
      const type = kind.get(first.id);
      const points = start ? [point(start), point(first)] : [point(first)];
      let current = first;
      for (;;) {
        const next = children.get(current.id) ?? [];
        if (next.length !== 1 || kind.get(next[0].id) !== type) break;
        current = next[0];
        points.push(point(current));
      }
      let length = 0;
      for (let k = 1; k < points.length; k++) length += distance(points[k - 1], points[k]);
      const section = { type, points, children: [], branchOrder, pathEnd: pathStart + length, length };
      sections.push(section);
      return { section, current };
    };
    const first = grow(root, null, 0, 0);
    const stack = [first];
    while (stack.length) {
      const { section, current } = stack.pop();
      for (const child of children.get(current.id) ?? []) {
        const grown = grow(child, current, section.branchOrder + 1, section.pathEnd);
        section.children.push(grown.section);
        stack.push(grown);
      }
    }
    return { type: kind.get(root.id), root: first.section, sections };
  });
  return { center, soma, neurites };
}

/** NeuroM's Strahler order: 1 at a leaf; i + 1 where two or more children reach the maximum i. */
function strahlerOrders(neurite) {
  const order = new Map();
  for (const section of [...neurite.sections].reverse()) {
    if (!section.children.length) {
      order.set(section, 1);
      continue;
    }
    const orders = section.children.map((child) => order.get(child));
    const top = Math.max(...orders);
    order.set(section, orders.filter((value) => value === top).length > 1 ? top + 1 : top);
  }
  return order;
}

function firstDistinct(points) {
  const origin = points[0];
  for (let k = 1; k < points.length; k++) {
    if (points[k][0] !== origin[0] || points[k][1] !== origin[1] || points[k][2] !== origin[2]) return points[k];
  }
  return points[1];
}

/** The neurites of one type, or all of them for `null`. */
export function neuritesOf(morphology, type) {
  return type == null ? morphology.neurites : morphology.neurites.filter((neurite) => neurite.type === type);
}

/**
 * The morphometrics of the neurites of one type (NeuroM's names in brackets).
 * @param {Morphology} morphology
 * @param {number | null} type NEURITE_TYPES value
 */
export function measure(morphology, type = null) {
  const result = {
    neurites: 0, // number_of_neurites
    sections: 0, // number_of_sections
    bifurcations: 0, // number_of_bifurcations: exactly two children
    forkingPoints: 0, // number_of_forking_points: two or more children
    terminals: 0, // number_of_leaves
    totalLength: 0, // total_length
    surfaceArea: 0, // total_area: lateral surface of each segment's frustum
    volume: 0, // total_volume: each segment's frustum
    maxPathDistance: 0, // max(section_path_distances), from the neurite's first sample
    maxRadialDistance: 0, // max_radial_distance: from the soma centre to each terminal
    maxBranchOrder: 0, // max(section_branch_orders)
    maxStrahlerOrder: 0, // max(section_strahler_orders)
    localBifurcationAngles: [], // local_bifurcation_angles
    remoteBifurcationAngles: [], // remote_bifurcation_angles
    bifurcationRecords: [],
  };
  for (const neurite of neuritesOf(morphology, type)) {
    result.neurites++;
    const strahler = strahlerOrders(neurite);
    for (const section of neurite.sections) {
      result.sections++;
      const { points, children } = section;
      for (let k = 1; k < points.length; k++) {
        const [r0, r1] = [points[k - 1][3], points[k][3]];
        const h = distance(points[k - 1], points[k]);
        result.totalLength += h;
        result.surfaceArea += Math.PI * (r0 + r1) * Math.hypot(r0 - r1, h);
        result.volume += (Math.PI * h * (r0 * r0 + r0 * r1 + r1 * r1)) / 3;
      }
      result.maxPathDistance = Math.max(result.maxPathDistance, section.pathEnd);
      result.maxBranchOrder = Math.max(result.maxBranchOrder, section.branchOrder);
      result.maxStrahlerOrder = Math.max(result.maxStrahlerOrder, strahler.get(section));
      if (!children.length) {
        result.terminals++;
        result.maxRadialDistance = Math.max(result.maxRadialDistance, distance(points.at(-1), morphology.center));
      }
      if (children.length >= 2) result.forkingPoints++;
      if (children.length === 2) {
        result.bifurcations++;
        const at = points.at(-1);
        const local = angle(at, firstDistinct(children[0].points), firstDistinct(children[1].points));
        const remote = angle(at, children[0].points.at(-1), children[1].points.at(-1));
        result.localBifurcationAngles.push(local);
        result.remoteBifurcationAngles.push(remote);
        result.bifurcationRecords.push({
          neuriteType: neurite.type,
          branchOrder: section.branchOrder,
          pathDistance: section.pathEnd,
          radialDistance: distance(at, morphology.center),
          local,
          remote,
        });
      }
    }
  }
  return result;
}

/** The largest distance of any neurite point from the soma centre. */
export function extent(morphology) {
  let far = 0;
  for (const neurite of morphology.neurites) {
    for (const section of neurite.sections) {
      for (const p of section.points) far = Math.max(far, distance(p, morphology.center));
    }
  }
  return far;
}

/** Sholl radii: step, 2 step, … up to the farthest neurite point. */
export function shollRadii(morphology, step) {
  if (!(step > 0)) throw new Error("The Sholl step must be a positive number.");
  const count = Math.floor(extent(morphology) / step);
  if (count > 100000) throw new Error("The Sholl step is too small for this neuron's size.");
  return Array.from({ length: count }, (_, k) => step * (k + 1));
}

/**
 * Sholl crossings as NeuroM's sholl_crossings counts them: a segment crosses radius r
 * when r² lies between the squared distances of its ends from the centre, inclusively,
 * so a branch that bends back crosses again.
 */
export function shollCrossings(morphology, radii, type = null) {
  const counts = new Array(radii.length).fill(0);
  const squared = radii.map((r) => r * r);
  const [cx, cy, cz] = morphology.center;
  for (const neurite of neuritesOf(morphology, type)) {
    for (const section of neurite.sections) {
      const { points } = section;
      let previous = (points[0][0] - cx) ** 2 + (points[0][1] - cy) ** 2 + (points[0][2] - cz) ** 2;
      for (let k = 1; k < points.length; k++) {
        const current = (points[k][0] - cx) ** 2 + (points[k][1] - cy) ** 2 + (points[k][2] - cz) ** 2;
        const low = Math.min(previous, current);
        const high = Math.max(previous, current);
        for (let i = 0; i < squared.length; i++) if (low <= squared[i] && squared[i] <= high) counts[i]++;
        previous = current;
      }
    }
  }
  return counts;
}

/** Everything the app reports for one morphology. */
export function analyse(morphology, step) {
  const radii = shollRadii(morphology, step);
  const features = {};
  const crossings = {};
  for (const [name, type] of Object.entries(NEURITE_TYPES)) {
    features[name] = measure(morphology, type);
    crossings[name] = shollCrossings(morphology, radii, type);
  }
  return { center: morphology.center, features, sholl: { step, radii, crossings } };
}
