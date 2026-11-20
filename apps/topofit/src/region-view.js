// Display helpers for a named search region: the parcellation drawn on the mid-surface
// and the region mask's colours on the slices.
import { readAnnotation } from '@neurodesk/topofit/results';
import { writeMz3 } from '@neurodesk/webapp-components/file-io/mesh';

// The left and right colours of the white surfaces, so a hemisphere reads the same everywhere.
export const HEMISPHERE_COLOURS = Object.freeze({ lh: [90, 178, 255], rh: [255, 178, 77] });
const SURFACE = [150, 150, 150];
const PATCH = [255, 255, 255];
// Areas outside the search region keep a weaker share of their atlas colour.
const OUTSIDE_REGION = 0.4;

// One RGBA quadruple per vertex: the search region in its atlas colours, the other atlas
// areas faded towards grey, unlabelled cortex grey and patch vertices white.
export function parcellationColours(labels, table, region, patchVertices = new Set()) {
  const colours = new Uint8Array(labels.length * 4);
  for (let vertex = 0; vertex < labels.length; vertex += 1) {
    const label = labels[vertex];
    const rgb = label ? table[label].rgb : SURFACE;
    const weight = !label || region.has(label) ? 1 : OUTSIDE_REGION;
    const colour = patchVertices.has(vertex) ? PATCH : rgb.map((value, channel) => Math.round(weight * value + (1 - weight) * SURFACE[channel]));
    colours.set([...colour, 255], vertex * 4);
  }
  return colours;
}

export function midSurface(white, pial) {
  return Float32Array.from(white, (value, index) => (value + pial[index]) / 2);
}

// Mean mid-surface position of the region's vertices, or null when it has none.
export function regionCentroid(points, labels, region) {
  const sum = [0, 0, 0];
  let count = 0;
  for (let vertex = 0; vertex < labels.length; vertex += 1) {
    if (!region.has(labels[vertex])) continue;
    for (let axis = 0; axis < 3; axis += 1) sum[axis] += points[vertex * 3 + axis];
    count += 1;
  }
  return count ? sum.map((value) => value / count) : null;
}

// Mean white-to-pial direction of the region's vertices, which points out of the cortex.
export function regionOutward(white, pial, labels, region) {
  const sum = [0, 0, 0];
  for (let vertex = 0; vertex < labels.length; vertex += 1) {
    if (!region.has(labels[vertex])) continue;
    for (let axis = 0; axis < 3; axis += 1) sum[axis] += pial[vertex * 3 + axis] - white[vertex * 3 + axis];
  }
  return sum;
}

// NiiVue's camera angles for a camera placed along `direction` from the scene: azimuth 0
// views from behind, 90 from the left and 270 from the right; elevation is positive above.
// Null when the direction is too short to choose one.
export function cameraAlong([dx, dy, dz]) {
  const horizontal = Math.hypot(dx, dy);
  if (Math.hypot(horizontal, dz) < 1e-6) return null;
  const azimuth = horizontal < 1e-6 ? 0 : (Math.atan2(-dx, -dy) * 180 / Math.PI + 360) % 360;
  const elevation = Math.atan2(dz, horizontal) * 180 / Math.PI;
  return { azimuth, elevation };
}

// A label colormap for the region mask: 1 is the left hemisphere, 2 the right.
export function regionMaskColormap(regionName) {
  return {
    R: [0, HEMISPHERE_COLOURS.lh[0], HEMISPHERE_COLOURS.rh[0]],
    G: [0, HEMISPHERE_COLOURS.lh[1], HEMISPHERE_COLOURS.rh[1]],
    B: [0, HEMISPHERE_COLOURS.lh[2], HEMISPHERE_COLOURS.rh[2]],
    A: [0, 255, 255],
    I: [0, 1, 2],
    labels: ['', `Left ${regionName}`, `Right ${regionName}`],
  };
}

// The hemisphere's mid-surface coloured by its parcellation, as an mz3 mesh, where the
// region lies on it and a camera that faces the region's outer side.
export function parcellationMesh({ annotation, white, pial, faces, region, patchVertices }) {
  const { labels, table } = readAnnotation(annotation);
  if (labels.length * 3 !== white.length) throw new Error('The parcellation does not match the reconstructed surface.');
  const points = midSurface(white, pial);
  return {
    bytes: writeMz3(points, faces, parcellationColours(labels, table, region, patchVertices)),
    centroid: regionCentroid(points, labels, region),
    camera: cameraAlong(regionOutward(white, pial, labels, region)),
  };
}
