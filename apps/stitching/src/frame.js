// The display frame shared by the layout preview and the stitched image, and the tile outlines
// drawn on it. Both images are placed on one grid, so switching between them in the viewer
// keeps every pixel where it was and only the tiles' alignment changes.
import { fusedGeometry } from "./core/fusion.js";

/** The smallest grid (origin and shape, pixels) that holds the tiles under every set of positions. */
export function displayFrame(shapes, positionSets) {
  const geometries = positionSets.map((positions) => fusedGeometry(shapes, positions));
  const dims = shapes[0].length;
  const origin = [];
  const shape = [];
  for (let d = 0; d < dims; d++) {
    const low = Math.min(...geometries.map((g) => g.origin[d]));
    const high = Math.max(...geometries.map((g) => g.origin[d] + g.shape[d]));
    origin.push(low);
    shape.push(high - low);
  }
  return { origin, shape };
}

/** A fused image (`data`, `shape`, `origin`) copied into `frame`, zero where it has no pixels. */
export function placeInFrame(image, frame) {
  const [fx, fy = 1, fz = 1] = frame.shape;
  const [nx, ny = 1, nz = 1] = image.shape;
  const offset = frame.origin.map((o, d) => image.origin[d] - o);
  const [dx, dy = 0, dz = 0] = offset;
  if (offset.some((v, d) => v < 0 || v + image.shape[d] > frame.shape[d])) throw new Error("The image does not fit the display frame.");
  const out = new image.data.constructor(fx * fy * fz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      const from = (z * ny + y) * nx;
      out.set(image.data.subarray(from, from + nx), ((z + dz) * fy + (y + dy)) * fx + dx);
    }
  }
  return out;
}

/**
 * Each tile's outline in the viewer's world coordinates (millimetres), as NiiVue axial slice
 * rectangles: `{ tile, slicePosition, outer }` per tile and per plane it covers. The display
 * NIfTI puts frame pixel (i, j, k) at (i·sx, (ny − 1 − j)·sy, k·sz), so a tile at position p
 * (sub-pixel) spans from p − ½ to p + n − ½ pixels along each axis.
 */
export function tileOutlinePolygons(shapes, positions, frame, spacing) {
  const [sx, sy, sz] = spacing;
  const fy = frame.shape[1] ?? 1;
  const fz = frame.shape[2] ?? 1;
  const outlines = [];
  shapes.forEach((shape, t) => {
    const [nx, ny = 1, nz = 1] = shape;
    const [px, py = 0, pz = 0] = positions[t].map((p, d) => p - frame.origin[d]);
    const left = (px - 0.5) * sx;
    const right = (px + nx - 0.5) * sx;
    const top = (fy - 1 - (py - 0.5)) * sy;
    const bottom = (fy - 1 - (py + ny - 0.5)) * sy;
    const outer = [{ x: left, y: top }, { x: right, y: top }, { x: right, y: bottom }, { x: left, y: bottom }];
    const first = Math.max(0, Math.round(pz));
    const last = Math.min(fz - 1, Math.round(pz) + nz - 1);
    for (let k = first; k <= last; k++) outlines.push({ tile: t, slicePosition: k * sz, outer });
  });
  return outlines;
}

/** The largest distance (pixels) between a tile's layout position and its registered one. */
export function largestMove(approximate, registered) {
  return Math.max(...registered.map((p, t) => Math.hypot(...p.map((v, d) => v - approximate[t][d]))));
}
