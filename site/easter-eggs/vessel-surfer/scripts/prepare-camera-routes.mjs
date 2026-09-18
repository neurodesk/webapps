// Refine navigation coordinates against the exact rendered surface. Does not
// change the human segmentation or mesh. Run after prepare-human-network.py.
import * as THREE from "three";
import { MeshBVH } from "three-mesh-bvh";
import { readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { surfaceGuard } from "../src/surface-guard.js";
import { sampleMask } from "../src/mask.js";
const dir = new URL("../public/data/", import.meta.url),
  read = (name) => readFileSync(new URL(name, dir));
const metadata = JSON.parse(read("brain.json")),
  network = JSON.parse(read("brain-network.json"));
const volume = {
  ...metadata,
  field: new Uint8Array(gunzipSync(read("brain-field.gz"))),
  valueScale: 255,
};
const raw = read("brain-surface.bin"),
  buffer = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength),
  view = new DataView(buffer);
const vertices = view.getUint32(0, true),
  count = view.getUint32(4, true),
  geometry = new THREE.BufferGeometry();
geometry.setAttribute(
  "position",
  new THREE.BufferAttribute(new Float32Array(buffer, 8, vertices * 3), 3),
);
geometry.setIndex(
  new THREE.BufferAttribute(
    new Uint32Array(buffer, 8 + vertices * 12, count),
    1,
  ),
);
const bvh = new MeshBVH(geometry, { indirect: true }),
  positions = geometry.attributes.position,
  indices = geometry.index.array;
const a = new THREE.Vector3(),
  b = new THREE.Vector3(),
  c = new THREE.Vector3(),
  n = new THREE.Vector3(),
  nearest = {};
const margin = 0.015,
  cache = new Map();
let corrected = 0,
  samples = 0;
function refine(coords) {
  const key = coords.map((v) => v.toFixed(6)).join(",");
  if (cache.has(key)) return cache.get(key);
  const p = new THREE.Vector3(...coords);
  let changed = false;
  for (let i = 0; i < 80; i++) {
    bvh.closestPointToPoint(p, nearest);
    const face = nearest.faceIndex * 3;
    a.fromBufferAttribute(positions, indices[face]);
    b.fromBufferAttribute(positions, indices[face + 1]);
    c.fromBufferAttribute(positions, indices[face + 2]);
    n.copy(b).sub(a).cross(c.sub(a)).normalize();
    const signed = p.clone().sub(nearest.point).dot(n);
    if (signed >= margin) break;
    p.addScaledVector(n, margin - signed + 0.002);
    changed = true;
  }
  // A lumen too thin to hold the clearance is not routable; its branch is
  // dropped below rather than bridged or widened.
  if (sampleMask(volume, p.toArray()) <= 0.54) {
    cache.set(key, null);
    return null;
  }
  if (changed) corrected++;
  const point = p.toArray().map((v) => Number(v.toFixed(6)));
  cache.set(key, point);
  return point;
}
const refinedNodes = network.nodes.map(refine);
let thin = 0;
network.edges = network.edges.filter((edge) => {
  if (refinedNodes[edge.a] && refinedNodes[edge.b]) return true;
  thin++;
  return false;
});
// Nodes that cannot hold the clearance keep their source coordinate; no
// remaining edge references them.
network.nodes = network.nodes.map((node, i) => refinedNodes[i] || node);
for (const edge of network.edges) {
  const pts = [];
  for (let i = 1; i < edge.points.length; i++) {
    const from = new THREE.Vector3(...edge.points[i - 1]),
      to = new THREE.Vector3(...edge.points[i]);
    const steps = Math.max(1, Math.ceil(from.distanceTo(to) / 0.01));
    for (let j = 0; j < steps; j++)
      pts.push(
        refine(
          from
            .clone()
            .lerp(to, j / steps)
            .toArray(),
        ),
      );
  }
  if (pts.some((p) => p === null)) {
    edge.points = null;
    thin++;
    continue;
  }
  pts.push(network.nodes[edge.b]);
  pts[0] = network.nodes[edge.a];
  // Keep corrected bends, but remove exactly collinear intermediate samples.
  const compact = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = new THREE.Vector3(...pts[i]),
      before = new THREE.Vector3(...compact.at(-1)),
      after = new THREE.Vector3(...pts[i + 1]);
    const line = new THREE.Line3(before, after);
    if (
      line.closestPointToPoint(p, true, new THREE.Vector3()).distanceTo(p) >
      0.00002
    )
      compact.push(pts[i]);
  }
  compact.push(pts.at(-1));
  edge.points = compact;
  samples += compact.length;
}
// Exclude segmentation connections that cannot accommodate a continuous camera
// path through the actual surface, keep the largest routable component, and
// launch from its widest long trunk.
const guard = surfaceGuard(geometry, true);
const valid = network.edges.filter((edge) => {
  if (!edge.points) return false;
  const points = edge.points.map((p) => new THREE.Vector3(...p));
  return points.every((p, i) => {
    if (!guard.surfaceInside(p.toArray())) return false;
    if (i === 0) return true;
    const from = points[i - 1];
    if (!guard.surfaceClear(from, p)) return false;
    const steps = Math.ceil(from.distanceTo(p) / 0.005);
    for (let j = 1; j < steps; j++)
      if (
        !guard.surfaceInside(
          from
            .clone()
            .lerp(p, j / steps)
            .toArray(),
        )
      )
        return false;
    return true;
  });
});
const componentOf = new Map();
let componentCount = 0;
for (const edge of valid) {
  if (componentOf.has(edge.a) || componentOf.has(edge.b)) continue;
  const id = componentCount++;
  const queue = [edge.a];
  componentOf.set(edge.a, id);
  while (queue.length) {
    const node = queue.pop();
    for (const other of valid)
      for (const next of [other.a, other.b])
        if ((other.a === node || other.b === node) && !componentOf.has(next)) {
          componentOf.set(next, id);
          queue.push(next);
        }
  }
}
const edgeLength = (edge) =>
  edge.points.reduce(
    (sum, p, i) =>
      i ? sum + Math.hypot(...p.map((v, k) => v - edge.points[i - 1][k])) : 0,
    0,
  );
const componentLength = new Map();
for (const edge of valid)
  componentLength.set(
    componentOf.get(edge.a),
    (componentLength.get(componentOf.get(edge.a)) || 0) + edgeLength(edge),
  );
const largest = [...componentLength.entries()].sort((a, b) => b[1] - a[1])[0][0];
network.edges = valid.filter((e) => componentOf.get(e.a) === largest);
const degree = new Map();
for (const edge of network.edges)
  for (const node of [edge.a, edge.b]) degree.set(node, (degree.get(node) || 0) + 1);
const trunks = network.edges.filter(
  (e) => degree.get(e.a) > 2 && degree.get(e.b) > 2 && edgeLength(e) > 4,
);
const candidates = trunks.length
  ? trunks
  : network.edges.filter((e) => edgeLength(e) > 4);
if (!candidates.length) throw new Error("No launch trunk survived validation");
const startEdge = candidates.reduce((best, e) =>
  e.radius ** 2 * Math.min(15, edgeLength(e)) >
  best.radius ** 2 * Math.min(15, edgeLength(best))
    ? e
    : best,
);
network.start = {
  edge: network.edges.indexOf(startEdge),
  reverse: false,
  progress: 0.25,
};
metadata.routableComponents = componentCount;
metadata.routableLengthMm = Number(componentLength.get(largest).toFixed(2));
metadata.branches = network.edges.length;
samples = network.edges.reduce((sum, e) => sum + e.points.length, 0);
metadata.processing = metadata.processing.replace(
  / Route refinement against rendered triangles with a 0.015 mm inward margin\./g,
  "",
);
writeFileSync(new URL("brain-network.json", dir), JSON.stringify(network));
metadata.routeSamples = samples;
metadata.cameraClearanceMm = margin;
metadata.processing +=
  " Route refinement against rendered triangles with a 0.015 mm inward margin.";
writeFileSync(
  new URL("brain.json", dir),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log({ corrected, samples, thin, components: componentCount, branches: network.edges.length, startRadius: startEdge.radius, startLength: edgeLength(startEdge).toFixed(2) });
