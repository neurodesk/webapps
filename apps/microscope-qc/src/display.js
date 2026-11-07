// NIfTI files that feed NiiVue only (downloads are TIFF, CSV and JSON). The shared NIfTI writer
// works in millimetres, so micrometre voxel sizes are divided by 1000. Row 0 of the image is
// drawn at the top: the y axis is flipped in the affine.
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";

/** NIfTI spacing (mm) for a voxel size in micrometres. */
export function displaySpacing({ x, y, z }) {
  return [x / 1000, y / 1000, z / 1000];
}

/** The 1st and 99.9th percentiles of up to 200 000 evenly strided samples: a display window. */
function displayWindow(data) {
  const step = Math.max(1, Math.floor(data.length / 200000));
  const sample = [];
  for (let i = 0; i < data.length; i += step) sample.push(data[i]);
  sample.sort((a, b) => a - b);
  const low = sample[Math.floor(0.01 * (sample.length - 1))];
  const high = sample[Math.floor(0.999 * (sample.length - 1))];
  return high > low ? [low, high] : [sample[0], sample[0] + 1];
}

/** The affine NiiVue uses for a stack of `height` rows with spacing in mm. */
export function displayAffine(height, [sx, sy, sz]) {
  return [
    [sx, 0, 0, 0],
    [0, -sy, 0, (height - 1) * sy],
    [0, 0, sz, 0],
    [0, 0, 0, 1],
  ];
}

/** A 3D volume (planes ≥ 1) as a NIfTI File. */
export function displayNifti(name, data, { width, height, planes, spacing, window = displayWindow(data) }) {
  const [sx, sy, sz] = spacing;
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, width, height, planes, 1, 1, 1, 1], pixDims: [1, sx, sy, sz, 1, 1, 1, 1], affine: displayAffine(height, spacing) } });
  const buffer = createNiftiFromData(data, header, { dims: [width, height, planes], preserveScaling: true, calMin: window[0], calMax: window[1], clampCalMax: false });
  return new File([buffer], name, { type: "application/octet-stream" });
}

/**
 * Bead overlay labels on the z maximum projection: the outline of every bead's crop box.
 * 1 = used, 2 = poor fit, 3 = rejected.
 */
export function beadOverlay(beads, { width, height }, halfBox) {
  const labels = new Uint8Array(width * height);
  for (const bead of beads) {
    const label = bead.rejection ? 3 : bead.goodFit ? 1 : 2;
    for (let d = -halfBox; d <= halfBox; d++) {
      for (const [x, y] of [[bead.peakX + d, bead.peakY - halfBox], [bead.peakX + d, bead.peakY + halfBox], [bead.peakX - halfBox, bead.peakY + d], [bead.peakX + halfBox, bead.peakY + d]]) {
        if (x >= 0 && y >= 0 && x < width && y < height) labels[y * width + x] = label;
      }
    }
  }
  return labels;
}

export const BEAD_COLORMAP = Object.freeze({
  R: [0, 70, 240, 200],
  G: [0, 200, 180, 70],
  B: [0, 90, 40, 70],
  A: [0, 255, 255, 255],
  I: [0, 1, 2, 3],
  labels: ["", "Used", "Poor fit", "Rejected"],
});

/** Iso-intensity zones (0, 10, …, 100 %) as labels 1…11 so 0 % is still drawn. */
export function zoneLabels(zones, step) {
  const out = new Uint8Array(zones.length);
  for (let i = 0; i < zones.length; i++) out[i] = Math.round(zones[i] / step) + 1;
  return out;
}

/** A dark-to-bright ramp for the zone labels. */
export function zoneColormap(step) {
  const count = Math.round(100 / step) + 1;
  const map = { R: [0], G: [0], B: [0], A: [0], I: [0], labels: [""] };
  for (let k = 0; k < count; k++) {
    const t = count > 1 ? k / (count - 1) : 1;
    map.R.push(Math.round(30 + 225 * t));
    map.G.push(Math.round(20 + 200 * t ** 1.5));
    map.B.push(Math.round(90 * (1 - t)));
    map.A.push(255);
    map.I.push(k + 1);
    map.labels.push(`${Math.round(k * step)}%`);
  }
  return map;
}
