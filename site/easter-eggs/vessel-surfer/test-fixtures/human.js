import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { createNetwork } from "../src/network.js";
const read = (name) =>
  readFileSync(new URL("../public/data/" + name, import.meta.url));
export const metadata = JSON.parse(read("ixi322.json"));
export const volume = {
  ...metadata,
  field: new Uint8Array(gunzipSync(read("ixi322-field.gz"))),
  valueScale: 255,
};
export const network = createNetwork(JSON.parse(read("ixi322-network.json")));

import * as THREE from "three";
import { surfaceGuard } from "../src/surface-guard.js";
const raw = read("ixi322-surface.bin");
const buffer = raw.buffer.slice(
    raw.byteOffset,
    raw.byteOffset + raw.byteLength,
  ),
  header = new DataView(buffer);
const vertexCount = header.getUint32(0, true),
  indexCount = header.getUint32(4, true);
export const geometry = new THREE.BufferGeometry();
geometry.setAttribute(
  "position",
  new THREE.BufferAttribute(new Float32Array(buffer, 8, vertexCount * 3), 3),
);
geometry.setIndex(
  new THREE.BufferAttribute(
    new Uint32Array(buffer, 8 + vertexCount * 12, indexCount),
    1,
  ),
);
Object.assign(volume, surfaceGuard(geometry, true));
