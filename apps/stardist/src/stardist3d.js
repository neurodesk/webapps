// StarDist 3D post-processing and tiling, ported from StarDist 0.9.1 (model3d.py, nms.py,
// geom3d.py and stardist3d_impl.cpp) and csbdeep 0.8.1. Pure and DOM-free: the worker and the
// Node tests import it.
import { axisTiles, cropStop, descendingOrder, normalize, reflectIndex } from "./stardist.js";

const f32 = Math.fround;
const N_THETA = 16;
const N_PHI = 32;

/** IEEE-754 round-half-to-even, matching C99 `lrint(r)` in `stardist3d_impl.cpp`. */
function lrint(r) {
  const floor = Math.floor(r);
  const diff = r - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor & 1 ? floor + 1 : floor;
}

/** StarDistPadAndCropResizer.before in 3D: reflect-pad the end of each axis to a multiple of `divBy`. */
export function padVolume(data, depth, height, width, divBy) {
  const [divZ, divY, divX] = divBy;
  const padDepth = depth + ((divZ - (depth % divZ)) % divZ);
  const padHeight = height + ((divY - (height % divY)) % divY);
  const padWidth = width + ((divX - (width % divX)) % divX);
  if (padDepth === depth && padHeight === height && padWidth === width) {
    return { data, depth, height, width };
  }
  const out = new Float32Array(padDepth * padHeight * padWidth);
  for (let z = 0; z < padDepth; z++) {
    const srcZ = reflectIndex(z, depth) * height * width;
    const dstZ = z * padHeight * padWidth;
    for (let y = 0; y < padHeight; y++) {
      const srcY = srcZ + reflectIndex(y, height) * width;
      const dstY = dstZ + y * padWidth;
      for (let x = 0; x < padWidth; x++) out[dstY + x] = data[srcY + reflectIndex(x, width)];
    }
  }
  return { data: out, depth: padDepth, height: padHeight, width: padWidth };
}

/** Automatic 3D tiling: keeps each tile within a modest WebAssembly memory budget. */
export function automaticTiles3D(depth, height, width, maxZ = 64, maxXY = 256) {
  return [
    Math.max(1, Math.ceil(depth / maxZ)),
    Math.max(1, Math.ceil(height / maxXY)),
    Math.max(1, Math.ceil(width / maxXY)),
  ];
}

/**
 * StarDist3D._predict_sparse_generator: run the 3D network tile by tile on the padded volume,
 * keeping grid voxels whose probability exceeds `probThresh`, not within `b = 2` grid voxels of
 * the padded volume border, and inside `(depth, height, width)`.
 */
export async function predictCandidates3D(volume, depth, height, width, model, options) {
  const { probThresh, nTiles = [1, 1, 1], run, onTile = () => {} } = options;
  const [gridZ, gridY, gridX] = model.grid;
  const [divZ, divY, divX] = model.divBy;
  const { tileOverlap, nRays } = model;
  const padded = padVolume(volume, depth, height, width, model.divBy);
  const overlapBlocks = [
    Math.ceil(tileOverlap[0] / divZ),
    Math.ceil(tileOverlap[1] / divY),
    Math.ceil(tileOverlap[2] / divX),
  ];
  const tilesZ = axisTiles(padded.depth, nTiles[0], divZ, overlapBlocks[0]);
  const tilesY = axisTiles(padded.height, nTiles[1], divY, overlapBlocks[1]);
  const tilesX = axisTiles(padded.width, nTiles[2], divX, overlapBlocks[2]);
  const gridDepth = padded.depth / gridZ;
  const gridHeight = padded.height / gridY;
  const gridWidth = padded.width / gridX;
  const threshold = f32(probThresh);
  const prob = [];
  const dist = [];
  const points = [];
  const total = tilesZ.length * tilesY.length * tilesX.length;
  let done = 0;
  for (const tz of tilesZ) {
    for (const ty of tilesY) {
      for (const tx of tilesX) {
        const tileDepth = tz.read[1] - tz.read[0];
        const tileHeight = ty.read[1] - ty.read[0];
        const tileWidth = tx.read[1] - tx.read[0];
        const input = new Float32Array(tileDepth * tileHeight * tileWidth);
        for (let z = 0; z < tileDepth; z++) {
          const srcZ = (tz.read[0] + z) * padded.height * padded.width;
          const dstZ = z * tileHeight * tileWidth;
          for (let y = 0; y < tileHeight; y++) {
            const from = srcZ + (ty.read[0] + y) * padded.width + tx.read[0];
            input.set(padded.data.subarray(from, from + tileWidth), dstZ + y * tileWidth);
          }
        }
        const output = await run(input, tileDepth, tileHeight, tileWidth);
        const outHeight = tileHeight / gridY;
        const outWidth = tileWidth / gridX;
        const sliceZ = cropStop(tz, tileDepth, gridZ);
        const sliceY = cropStop(ty, tileHeight, gridY);
        const sliceX = cropStop(tx, tileWidth, gridX);
        const dstZ = [tz.write[0] / gridZ, tz.write[1] / gridZ];
        const dstY = [ty.write[0] / gridY, ty.write[1] / gridY];
        const dstX = [tx.write[0] / gridX, tx.write[1] / gridX];
        const b = 2;
        const z0 = sliceZ[0] + (dstZ[0] === 0 ? b : 0);
        const z1 = sliceZ[1] - (dstZ[1] === gridDepth ? b : 0);
        const y0 = sliceY[0] + (dstY[0] === 0 ? b : 0);
        const y1 = sliceY[1] - (dstY[1] === gridHeight ? b : 0);
        const x0 = sliceX[0] + (dstX[0] === 0 ? b : 0);
        const x1 = sliceX[1] - (dstX[1] === gridWidth ? b : 0);
        for (let z = z0; z < z1; z++) {
          const pz = (dstZ[0] + z - sliceZ[0]) * gridZ;
          if (pz >= depth) continue;
          for (let y = y0; y < y1; y++) {
            const py = (dstY[0] + y - sliceY[0]) * gridY;
            if (py >= height) continue;
            for (let x = x0; x < x1; x++) {
              const at = (z * outHeight + y) * outWidth + x;
              const p = output.prob[at];
              if (!(p > threshold)) continue;
              const px = (dstX[0] + x - sliceX[0]) * gridX;
              if (px >= width) continue;
              prob.push(p);
              points.push(pz, py, px);
              for (let k = 0; k < nRays; k++) dist.push(Math.max(f32(1e-3), output.dist[at * nRays + k]));
            }
          }
        }
        onTile(++done, total);
      }
    }
  }
  return { prob: Float32Array.from(prob), dist: Float32Array.from(dist), points: Int32Array.from(points), tiles: total };
}

/**
 * Precomputed ray geometry and spherical face index: each `(theta, phi)` bin holds the subset of
 * faces whose solid cone can touch that bin, so `insidePolyhedron` tests ~3 faces instead of 188
 * while remaining mathematically identical to testing every face.
 */
function prepareRays(rays) {
  const nRays = rays.vertices.length;
  const nFaces = rays.faces.length;
  const verts = new Float32Array(nRays * 3);
  for (let i = 0; i < nRays; i++) {
    verts[3 * i] = f32(rays.vertices[i][0]);
    verts[3 * i + 1] = f32(rays.vertices[i][1]);
    verts[3 * i + 2] = f32(rays.vertices[i][2]);
  }
  const faces = new Int32Array(nFaces * 3);
  for (let f = 0; f < nFaces; f++) {
    faces[3 * f] = rays.faces[f][0];
    faces[3 * f + 1] = rays.faces[f][1];
    faces[3 * f + 2] = rays.faces[f][2];
  }
  const faceCentroid = new Float64Array(nFaces * 3);
  const faceRadius = new Float64Array(nFaces);
  for (let f = 0; f < nFaces; f++) {
    const idx = [faces[3 * f], faces[3 * f + 1], faces[3 * f + 2]];
    const unit = idx.map((i) => {
      const vz = verts[3 * i];
      const vy = verts[3 * i + 1];
      const vx = verts[3 * i + 2];
      const norm = Math.hypot(vz, vy, vx);
      return [vz / norm, vy / norm, vx / norm];
    });
    let cz = unit[0][0] + unit[1][0] + unit[2][0];
    let cy = unit[0][1] + unit[1][1] + unit[2][1];
    let cx = unit[0][2] + unit[1][2] + unit[2][2];
    const norm = Math.hypot(cz, cy, cx);
    cz /= norm;
    cy /= norm;
    cx /= norm;
    faceCentroid[3 * f] = cz;
    faceCentroid[3 * f + 1] = cy;
    faceCentroid[3 * f + 2] = cx;
    const minDot = Math.min(...unit.map((u) => u[0] * cz + u[1] * cy + u[2] * cx));
    faceRadius[f] = Math.acos(Math.max(-1, Math.min(1, minDot))) + 0.05;
  }
  const dTheta = Math.PI / N_THETA;
  const dPhi = (2 * Math.PI) / N_PHI;
  const cellRadius = Math.hypot(dTheta, dPhi) * 0.6;
  const bins = Array.from({ length: N_THETA * N_PHI }, () => []);
  for (let it = 0; it < N_THETA; it++) {
    const theta = (it + 0.5) * dTheta;
    const sinT = Math.sin(theta);
    const cosT = Math.cos(theta);
    for (let ip = 0; ip < N_PHI; ip++) {
      const phi = -Math.PI + (ip + 0.5) * dPhi;
      const dz = cosT;
      const dy = sinT * Math.sin(phi);
      const dx = sinT * Math.cos(phi);
      const bin = bins[it * N_PHI + ip];
      for (let f = 0; f < nFaces; f++) {
        const dot = dz * faceCentroid[3 * f] + dy * faceCentroid[3 * f + 1] + dx * faceCentroid[3 * f + 2];
        if (Math.acos(Math.max(-1, Math.min(1, dot))) <= faceRadius[f] + cellRadius) bin.push(f);
      }
    }
  }
  return { nRays, nFaces, verts, faces, bins: bins.map((bin) => Int32Array.from(bin)) };
}

const rayCache = new WeakMap();
function getRays(rays) {
  let prepared = rayCache.get(rays);
  if (!prepared) {
    prepared = prepareRays(rays);
    rayCache.set(rays, prepared);
  }
  return prepared;
}

function insideHalfspace(z, y, x, Az, Ay, Ax, Bz, By, Bx, Cz, Cy, Cx) {
  const M00 = f32(Bz - Az);
  const M01 = f32(By - Ay);
  const M02 = f32(Bx - Ax);
  const M10 = f32(Cz - Az);
  const M11 = f32(Cy - Ay);
  const M12 = f32(Cx - Ax);
  const M20 = f32(z - Az);
  const M21 = f32(y - Ay);
  const M22 = f32(x - Ax);
  const det = f32(
    f32(
      f32(M00 * f32(f32(M11 * M22) - f32(M21 * M12))) -
      f32(M01 * f32(f32(M10 * M22) - f32(M12 * M20))),
    ) +
    f32(M02 * f32(f32(M10 * M21) - f32(M11 * M20))),
  );
  return det >= 0;
}

function insideTetrahedron(z, y, x, Rz, Ry, Rx, Az, Ay, Ax, Bz, By, Bx, Cz, Cy, Cx) {
  return (
    insideHalfspace(z, y, x, Az, Ay, Ax, Bz, By, Bx, Cz, Cy, Cx) &&
    insideHalfspace(z, y, x, Rz, Ry, Rx, Bz, By, Bx, Az, Ay, Ax) &&
    insideHalfspace(z, y, x, Rz, Ry, Rx, Cz, Cy, Cx, Bz, By, Bx) &&
    insideHalfspace(z, y, x, Rz, Ry, Rx, Az, Ay, Ax, Cz, Cy, Cx)
  );
}

function insidePolyhedron(z, y, x, center, polyverts, geom) {
  const Rz = center[0];
  const Ry = center[1];
  const Rx = center[2];
  const dz = z - Rz;
  const dy = y - Ry;
  const dx = x - Rx;
  const len = Math.hypot(dz, dy, dx);
  if (len < 1e-6) return true;
  let it = Math.floor((Math.acos(Math.max(-1, Math.min(1, dz / len))) / Math.PI) * N_THETA);
  if (it >= N_THETA) it = N_THETA - 1;
  let ip = Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * N_PHI);
  if (ip >= N_PHI) ip = N_PHI - 1;
  const candidates = geom.bins[it * N_PHI + ip];
  const { faces } = geom;
  for (let k = 0; k < candidates.length; k++) {
    const f = candidates[k];
    const iA = faces[3 * f];
    const iB = faces[3 * f + 1];
    const iC = faces[3 * f + 2];
    if (
      insideTetrahedron(
        z, y, x, Rz, Ry, Rx,
        polyverts[3 * iA], polyverts[3 * iA + 1], polyverts[3 * iA + 2],
        polyverts[3 * iB], polyverts[3 * iB + 1], polyverts[3 * iB + 2],
        polyverts[3 * iC], polyverts[3 * iC + 1], polyverts[3 * iC + 2],
      )
    ) {
      return true;
    }
  }
  return false;
}

function polyhedronVolume(d, geom) {
  const { verts, faces, nFaces } = geom;
  let vol = 0;
  for (let f = 0; f < nFaces; f++) {
    const iA = faces[3 * f];
    const iB = faces[3 * f + 1];
    const iC = faces[3 * f + 2];
    const Az = f32(d[iA] * verts[3 * iA]);
    const Ay = f32(d[iA] * verts[3 * iA + 1]);
    const Ax = f32(d[iA] * verts[3 * iA + 2]);
    const Bz = f32(d[iB] * verts[3 * iB]);
    const By = f32(d[iB] * verts[3 * iB + 1]);
    const Bx = f32(d[iB] * verts[3 * iB + 2]);
    const Cz = f32(d[iC] * verts[3 * iC]);
    const Cy = f32(d[iC] * verts[3 * iC + 1]);
    const Cx = f32(d[iC] * verts[3 * iC + 2]);
    const M00 = f32(Bz - Az);
    const M01 = f32(By - Ay);
    const M02 = f32(Bx - Ax);
    const M10 = f32(Cz - Az);
    const M11 = f32(Cy - Ay);
    const M12 = f32(Cx - Ax);
    const M20 = f32(-Az);
    const M21 = f32(-Ay);
    const M22 = f32(-Ax);
    const det = f32(
      f32(
        f32(M00 * f32(f32(M11 * M22) - f32(M21 * M12))) -
        f32(M01 * f32(f32(M10 * M22) - f32(M12 * M20))),
      ) +
      f32(M02 * f32(f32(M10 * M21) - f32(M11 * M20))),
    );
    vol = f32(vol + f32(det / 6));
  }
  return vol;
}

function polyhedronBbox(d, center, geom, out, offset) {
  const { verts, nRays } = geom;
  let z1 = 0x7fffffff;
  let z2 = -1;
  let y1 = 0x7fffffff;
  let y2 = -1;
  let x1 = 0x7fffffff;
  let x2 = -1;
  for (let j = 0; j < nRays; j++) {
    const iz = lrint(f32(center[0] + f32(d[j] * verts[3 * j])));
    const iy = lrint(f32(center[1] + f32(d[j] * verts[3 * j + 1])));
    const ix = lrint(f32(center[2] + f32(d[j] * verts[3 * j + 2])));
    if (iz < z1) z1 = iz;
    if (iz > z2) z2 = iz;
    if (iy < y1) y1 = iy;
    if (iy > y2) y2 = iy;
    if (ix < x1) x1 = ix;
    if (ix > x2) x2 = ix;
  }
  out[offset] = z1;
  out[offset + 1] = z2;
  out[offset + 2] = y1;
  out[offset + 3] = y2;
  out[offset + 4] = x1;
  out[offset + 5] = x2;
}

function polyvertsOf(d, center, geom) {
  const { verts, nRays } = geom;
  const pv = new Float32Array(3 * nRays);
  for (let j = 0; j < nRays; j++) {
    pv[3 * j] = f32(center[0] + f32(d[j] * verts[3 * j]));
    pv[3 * j + 1] = f32(center[1] + f32(d[j] * verts[3 * j + 1]));
    pv[3 * j + 2] = f32(center[2] + f32(d[j] * verts[3 * j + 2]));
  }
  return pv;
}

function boundingRadiusOuterIso(d, aniso, geom) {
  const { verts, nRays } = geom;
  let max2 = 0;
  for (let i = 0; i < nRays; i++) {
    const z = aniso[0] * d[i] * verts[3 * i];
    const y = aniso[1] * d[i] * verts[3 * i + 1];
    const x = aniso[2] * d[i] * verts[3 * i + 2];
    const r2 = z * z + y * y + x * x;
    if (r2 > max2) max2 = r2;
  }
  return Math.sqrt(max2);
}

function boundingRadiusInnerIso(d, aniso, geom) {
  const { verts, faces, nFaces } = geom;
  let minR = Infinity;
  for (let f = 0; f < nFaces; f++) {
    const iA = faces[3 * f];
    const iB = faces[3 * f + 1];
    const iC = faces[3 * f + 2];
    const Az = aniso[0] * d[iA] * verts[3 * iA];
    const Ay = aniso[1] * d[iA] * verts[3 * iA + 1];
    const Ax = aniso[2] * d[iA] * verts[3 * iA + 2];
    const Bz = aniso[0] * d[iB] * verts[3 * iB];
    const By = aniso[1] * d[iB] * verts[3 * iB + 1];
    const Bx = aniso[2] * d[iB] * verts[3 * iB + 2];
    const Cz = aniso[0] * d[iC] * verts[3 * iC];
    const Cy = aniso[1] * d[iC] * verts[3 * iC + 1];
    const Cx = aniso[2] * d[iC] * verts[3 * iC + 2];
    const pz = Bz - Az;
    const py = By - Ay;
    const px = Bx - Ax;
    const qz = Cz - Az;
    const qy = Cy - Ay;
    const qx = Cx - Ax;
    let Nz = px * qy - py * qx;
    let Ny = pz * qx - px * qz;
    let Nx = py * qz - pz * qy;
    const norm = 1 / (Math.sqrt(Nz * Nz + Ny * Ny + Nx * Nx) + 1e-10);
    Nz *= norm;
    Ny *= norm;
    Nx *= norm;
    const r = Az * Nz + Ay * Ny + Ax * Nx;
    if (r < minR) minR = r;
  }
  return minR;
}

function intersectSphereIso(r1, p1, r2, p2, aniso) {
  const dz = aniso[0] * (p1[0] - p2[0]);
  const dy = aniso[1] * (p1[1] - p2[1]);
  const dx = aniso[2] * (p1[2] - p2[2]);
  const d = Math.sqrt(dz * dz + dy * dy + dx * dx);
  if (d > r1 + r2) return 0;
  const rmin = Math.min(r1, r2);
  const rmax = Math.max(r1, r2);
  const scale = aniso[0] * aniso[1] * aniso[2];
  if (rmax >= d + rmin - 1e-10) return ((Math.PI * 4) / 3) * rmin * rmin * rmin / scale;
  const t = (r1 + r2 - d) / (2 * d);
  const h1 = (r2 - r1 + d) * t;
  const h2 = (r1 - r2 + d) * t;
  const v1 = (Math.PI / 3) * h1 * h1 * (3 * r1 - h1);
  const v2 = (Math.PI / 3) * h2 * h2 * (3 * r2 - h2);
  return (v1 + v2) / scale;
}

function intersectBbox(bbox, i, j) {
  const wz = Math.max(0, Math.min(bbox[6 * i + 1], bbox[6 * j + 1]) - Math.max(bbox[6 * i], bbox[6 * j]));
  const wy = Math.max(0, Math.min(bbox[6 * i + 3], bbox[6 * j + 3]) - Math.max(bbox[6 * i + 2], bbox[6 * j + 2]));
  const wx = Math.max(0, Math.min(bbox[6 * i + 5], bbox[6 * j + 5]) - Math.max(bbox[6 * i + 4], bbox[6 * j + 4]));
  return wz * wy * wx;
}

/**
 * `_COMMON_non_maximum_suppression_sparse` (stardist3d_impl.cpp) with `use_bbox`, spatial hash
 * grid and exact voxel rendering: `dist` (n × nRays) and `points` (n × 3, z/y/x) must already be
 * in descending probability order. Returns the surviving indices in that order.
 */
export function suppress3D(dist, points, rays, threshold) {
  const geom = getRays(rays);
  const { nRays } = geom;
  const n = points.length / 3;
  if (!n) return [];
  const pts = points instanceof Float32Array ? points : Float32Array.from(points);
  const volumes = new Float32Array(n);
  const bbox = new Int32Array(6 * n);
  const aniso = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const d = dist.subarray(i * nRays, (i + 1) * nRays);
    const p = pts.subarray(3 * i, 3 * i + 3);
    volumes[i] = polyhedronVolume(d, geom);
    polyhedronBbox(d, p, geom, bbox, 6 * i);
    aniso[0] += (bbox[6 * i + 1] - bbox[6 * i]) / n;
    aniso[1] += (bbox[6 * i + 3] - bbox[6 * i + 2]) / n;
    aniso[2] += (bbox[6 * i + 5] - bbox[6 * i + 4]) / n;
  }
  const maxAxis = Math.max(aniso[0], aniso[1], aniso[2]);
  aniso[0] = aniso[0] > 0 ? maxAxis / aniso[0] : 1;
  aniso[1] = aniso[1] > 0 ? maxAxis / aniso[1] : 1;
  aniso[2] = aniso[2] > 0 ? maxAxis / aniso[2] : 1;

  const rOuter = new Float32Array(n);
  const rOuterIso = new Float32Array(n);
  const rInnerIso = new Float32Array(n);
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    const d = dist.subarray(i * nRays, (i + 1) * nRays);
    let ro = 0;
    for (let k = 0; k < nRays; k++) if (d[k] > ro) ro = d[k];
    rOuter[i] = ro;
    if (ro > maxDist) maxDist = ro;
    rOuterIso[i] = boundingRadiusOuterIso(d, aniso, geom);
    rInnerIso[i] = boundingRadiusInnerIso(d, aniso, geom);
  }

  // Uniform 3D hash grid replacing nanoflann's kd-tree.
  const cell = Math.max(1, 2 * maxDist);
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(pts[3 * i] / cell)},${Math.floor(pts[3 * i + 1] / cell)},${Math.floor(pts[3 * i + 2] / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }

  const suppressed = new Uint8Array(n);
  const limit = f32(threshold);
  for (let i = 0; i < n - 1; i++) {
    if (suppressed[i]) continue;
    const pi = pts.subarray(3 * i, 3 * i + 3);
    const di = dist.subarray(i * nRays, (i + 1) * nRays);
    const bi0 = bbox[6 * i];
    const bi1 = bbox[6 * i + 1];
    const bi2 = bbox[6 * i + 2];
    const bi3 = bbox[6 * i + 3];
    const bi4 = bbox[6 * i + 4];
    const bi5 = bbox[6 * i + 5];
    const reach = maxDist + rOuter[i];
    const reach2 = reach * reach;
    const cz = Math.floor(pi[0] / cell);
    const cy = Math.floor(pi[1] / cell);
    const cx = Math.floor(pi[2] / cell);
    const span = Math.ceil(reach / cell);
    const Nz = bi1 - bi0 + 1;
    const Ny = bi3 - bi2 + 1;
    const Nx = bi5 - bi4 + 1;
    let rendered = null;
    for (let gz = cz - span; gz <= cz + span; gz++) {
      for (let gy = cy - span; gy <= cy + span; gy++) {
        for (let gx = cx - span; gx <= cx + span; gx++) {
          const members = cells.get(`${gz},${gy},${gx}`);
          if (!members) continue;
          for (const j of members) {
            if (j <= i || suppressed[j]) continue;
            const pj = pts.subarray(3 * j, 3 * j + 3);
            const dz = pi[0] - pj[0];
            const dy = pi[1] - pj[1];
            const dx = pi[2] - pj[2];
            if (!(dz * dz + dy * dy + dx * dx < reach2)) continue;
            const Amin = Math.min(volumes[i], volumes[j]);
            const Aupper = Math.min(intersectSphereIso(rOuterIso[i], pi, rOuterIso[j], pj, aniso), intersectBbox(bbox, i, j));
            if (Aupper < 1e-10 || Math.min(1, Aupper / (Amin + 1e-10)) <= limit) continue;
            const Alower = intersectSphereIso(rInnerIso[i], pi, rInnerIso[j], pj, aniso);
            if (Math.max(0, Alower / (Amin + 1e-10)) > limit) {
              suppressed[j] = 1;
              continue;
            }
            if (!rendered) {
              const pvi = polyvertsOf(di, pi, geom);
              rendered = new Uint8Array(Nz * Ny * Nx);
              for (let z = 0; z < Nz; z++) {
                const rz = z * Nx * Ny;
                for (let y = 0; y < Ny; y++) {
                  const ry = rz + y * Nx;
                  for (let x = 0; x < Nx; x++) {
                    if (insidePolyhedron(z + bi0, y + bi2, x + bi4, pi, pvi, geom)) rendered[ry + x] = 1;
                  }
                }
              }
            }
            const pvj = polyvertsOf(dist.subarray(j * nRays, (j + 1) * nRays), pj, geom);
            const maxOverlap = (Amin + 1e-10) * limit;
            const z0 = Math.max(bi0, bbox[6 * j]);
            const z1 = Math.min(bi1, bbox[6 * j + 1]);
            const y0 = Math.max(bi2, bbox[6 * j + 2]);
            const y1 = Math.min(bi3, bbox[6 * j + 3]);
            const x0 = Math.max(bi4, bbox[6 * j + 4]);
            const x1 = Math.min(bi5, bbox[6 * j + 5]);
            let inter = 0;
            outer: for (let z = z0; z <= z1; z++) {
              const rz = (z - bi0) * Nx * Ny;
              for (let y = y0; y <= y1; y++) {
                const ry = rz + (y - bi2) * Nx;
                for (let x = x0; x <= x1; x++) {
                  if (rendered[ry + (x - bi4)] && insidePolyhedron(z, y, x, pj, pvj, geom)) {
                    inter++;
                    if (inter > maxOverlap) {
                      suppressed[j] = 1;
                      break outer;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  const kept = [];
  for (let i = 0; i < n; i++) if (!suppressed[i]) kept.push(i);
  return kept;
}

/**
 * `polyhedron_to_label` (geom3d.py / stardist3d_impl.cpp): draws polyhedra in descending order
 * of probability, writing label `i + 1` only onto unlabelled voxels so more probable polyhedra
 * win where two overlap.
 */
export function renderLabels3D(dist, points, prob, rays, depth, height, width) {
  const geom = getRays(rays);
  const { nRays } = geom;
  const labels = new Int32Array(depth * height * width);
  const order = descendingOrder(prob);
  const bbox = new Int32Array(6);
  const planeSize = height * width;
  for (const i of order) {
    const d = dist.subarray(i * nRays, (i + 1) * nRays);
    const center = Float32Array.from([points[3 * i], points[3 * i + 1], points[3 * i + 2]]);
    polyhedronBbox(d, center, geom, bbox, 0);
    const pv = polyvertsOf(d, center, geom);
    const z0 = Math.max(0, bbox[0]);
    const z1 = Math.min(depth - 1, bbox[1]);
    const y0 = Math.max(0, bbox[2]);
    const y1 = Math.min(height - 1, bbox[3]);
    const x0 = Math.max(0, bbox[4]);
    const x1 = Math.min(width - 1, bbox[5]);
    const label = i + 1;
    for (let z = z0; z <= z1; z++) {
      const zOff = z * planeSize;
      for (let y = y0; y <= y1; y++) {
        const yOff = zOff + y * width;
        for (let x = x0; x <= x1; x++) {
          const at = yOff + x;
          if (labels[at] === 0 && insidePolyhedron(z, y, x, center, pv, geom)) labels[at] = label;
        }
      }
    }
  }
  return labels;
}

/** Per-nucleus 3D measurements matching `skimage.measure.regionprops`: centroid (x, y, z), volume, mean. */
export function measureNuclei3D(labels, volume, depth, height, width, count) {
  const area = new Float64Array(count + 1);
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  const sumZ = new Float64Array(count + 1);
  const sum = new Float64Array(count + 1);
  const plane = height * width;
  for (let z = 0; z < depth; z++) {
    const zOff = z * plane;
    for (let y = 0; y < height; y++) {
      const yOff = zOff + y * width;
      for (let x = 0; x < width; x++) {
        const at = yOff + x;
        const label = labels[at];
        if (!label) continue;
        area[label]++;
        sumX[label] += x;
        sumY[label] += y;
        sumZ[label] += z;
        sum[label] += volume[at];
      }
    }
  }
  const rows = [];
  for (let label = 1; label <= count; label++) {
    if (!area[label]) continue;
    rows.push({
      id: label,
      x: sumX[label] / area[label],
      y: sumY[label] / area[label],
      z: sumZ[label] / area[label],
      volume: area[label],
      mean: sum[label] / area[label],
    });
  }
  return rows;
}

/** Full StarDist 3D instance segmentation: normalize, predictCandidates3D, suppress3D, renderLabels3D, measureNuclei3D. */
export async function segment3D(raw, depth, height, width, model, options) {
  const { pmin = 1, pmax = 99.8, probThresh = model.thresholds.prob, nmsThresh = model.thresholds.nms, onStage = () => {} } = options;
  const normalized = normalize(raw, pmin, pmax);
  const candidates = await predictCandidates3D(normalized.data, depth, height, width, model, { ...options, probThresh });
  onStage("nms", candidates.prob.length);
  const order = descendingOrder(candidates.prob);
  const { nRays, rays } = model;
  const dist = new Float32Array(order.length * nRays);
  const points = new Int32Array(order.length * 3);
  order.forEach((from, to) => {
    dist.set(candidates.dist.subarray(from * nRays, (from + 1) * nRays), to * nRays);
    points[3 * to] = candidates.points[3 * from];
    points[3 * to + 1] = candidates.points[3 * from + 1];
    points[3 * to + 2] = candidates.points[3 * from + 2];
  });
  const kept = suppress3D(dist, points, rays, nmsThresh);
  const keptDist = new Float32Array(kept.length * nRays);
  const keptPoints = new Int32Array(kept.length * 3);
  const keptProb = new Float32Array(kept.length);
  kept.forEach((from, to) => {
    keptDist.set(dist.subarray(from * nRays, (from + 1) * nRays), to * nRays);
    keptPoints[3 * to] = points[3 * from];
    keptPoints[3 * to + 1] = points[3 * from + 1];
    keptPoints[3 * to + 2] = points[3 * from + 2];
    keptProb[to] = candidates.prob[order[from]];
  });
  onStage("labels", kept.length);
  const labels = renderLabels3D(keptDist, keptPoints, keptProb, rays, depth, height, width);
  const nuclei = measureNuclei3D(labels, raw, depth, height, width, kept.length).map((row) => ({
    ...row,
    probability: keptProb[row.id - 1],
  }));
  return {
    labels,
    nuclei,
    count: kept.length,
    candidates: candidates.prob.length,
    normalization: { low: normalized.low, high: normalized.high },
  };
}
