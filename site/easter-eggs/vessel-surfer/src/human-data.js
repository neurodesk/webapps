import * as THREE from "three";
import { createNetwork } from "./network.js";
import { surfaceGuard } from "./surface-guard.js";
export async function loadHumanData() {
  const base = import.meta.env.BASE_URL + "data/";
  const fetchAsset = async (name) => {
    const response = await fetch(base + name);
    if (!response.ok)
      throw new Error(
        `Human vessel data could not load (${response.status}). Use Restore human brain to retry.`,
      );
    return response;
  };
  const [meta, graph, rawField, rawMesh] = await Promise.all([
    fetchAsset("ixi322.json").then((r) => r.json()),
    fetchAsset("ixi322-network.json").then((r) => r.json()),
    fetchAsset("ixi322-field.gz").then((r) => r.arrayBuffer()),
    fetchAsset("ixi322-surface.bin").then((r) => r.arrayBuffer()),
  ]);
  const bytes = new Uint8Array(rawField);
  // Vite may serve .gz with Content-Encoding; fetch then already decompresses it.
  const field =
    bytes[0] === 31 && bytes[1] === 139
      ? new Uint8Array(
          await new Response(
            new Blob([rawField])
              .stream()
              .pipeThrough(new DecompressionStream("gzip")),
          ).arrayBuffer(),
        )
      : bytes;
  if (field.length !== meta.shape.reduce((a, b) => a * b, 1))
    throw new Error("Incomplete human vessel field. Retry loading.");
  const header = new DataView(rawMesh),
    vertices = header.getUint32(0, true),
    indices = header.getUint32(4, true);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(rawMesh, 8, vertices * 3), 3),
  );
  geometry.setIndex(
    new THREE.BufferAttribute(
      new Uint32Array(rawMesh, 8 + vertices * 12, indices),
      1,
    ),
  );
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  // Spatial chunks allow ordinary frustum culling inside the tunnel. All surface
  // triangles remain intact; this is not a cutaway or a change to the vessel.
  const positions = geometry.attributes.position;
  const cells = new Map();
  const point = new THREE.Vector3();
  for (let i = 0; i < indices; i += 3) {
    const ids = [
      geometry.index.array[i],
      geometry.index.array[i + 1],
      geometry.index.array[i + 2],
    ];
    point.set(0, 0, 0);
    for (const id of ids)
      point.add(new THREE.Vector3().fromBufferAttribute(positions, id));
    point.multiplyScalar(1 / 3);
    const key = [point.x, point.y, point.z]
      .map((v) => Math.floor(v / 8))
      .join(",");
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(...ids);
  }
  const chunks = [...cells.values()].map((ids) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", positions);
    g.setAttribute("normal", geometry.attributes.normal);
    g.setIndex(ids);
    const box = new THREE.Box3();
    for (const id of ids)
      box.expandByPoint(point.fromBufferAttribute(positions, id));
    g.boundingBox = box;
    g.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return g;
  });
  return {
    chunks,
    meta,
    volume: {
      ...meta,
      field,
      valueScale: 255,
      ...surfaceGuard(geometry, true),
    },
    network: createNetwork(graph),
    geometry,
  };
}
