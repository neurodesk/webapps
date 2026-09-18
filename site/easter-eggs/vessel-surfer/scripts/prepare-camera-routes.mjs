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
const metadata = JSON.parse(read("ixi322.json")),
  network = JSON.parse(read("ixi322-network.json"));
const volume = {
  ...metadata,
  field: new Uint8Array(gunzipSync(read("ixi322-field.gz"))),
  valueScale: 255,
};
const raw = read("ixi322-surface.bin"),
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
  if (sampleMask(volume, p.toArray()) <= 0.54)
    throw new Error("Surface refinement left the source lumen");
  if (changed) corrected++;
  const point = p.toArray().map((v) => Number(v.toFixed(6)));
  cache.set(key, point);
  return point;
}
network.nodes = network.nodes.map(refine);
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
// path through the actual surface. Retain only the component of the launch route.
const guard = surfaceGuard(geometry, true);
const startEdge = network.edges[network.start.edge];
const valid = network.edges.filter((edge) => {
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
const reached = new Set([startEdge.a, startEdge.b]);
let added = true;
while (added) {
  added = false;
  for (const edge of valid)
    if (reached.has(edge.a) || reached.has(edge.b)) {
      if (!reached.has(edge.a) || !reached.has(edge.b)) added = true;
      reached.add(edge.a);
      reached.add(edge.b);
    }
}
network.edges = valid.filter((e) => reached.has(e.a) && reached.has(e.b));
network.start.edge = network.edges.indexOf(startEdge);
if (network.start.edge < 0)
  throw new Error("Launch route failed surface validation");
metadata.branches = network.edges.length;
samples = network.edges.reduce((sum, e) => sum + e.points.length, 0);
metadata.processing = metadata.processing.replace(
  / Route refinement against rendered triangles with a 0.015 mm inward margin\./g,
  "",
);
writeFileSync(new URL("ixi322-network.json", dir), JSON.stringify(network));
metadata.routeSamples = samples;
metadata.cameraClearanceMm = margin;
metadata.processing +=
  " Route refinement against rendered triangles with a 0.015 mm inward margin.";
writeFileSync(
  new URL("ixi322.json", dir),
  JSON.stringify(metadata, null, 2) + "\n",
);
console.log({ corrected, samples });
