// SAM 2 / MedSAM2 prompt encoding, dynamic-stability mask selection, 3D label commitment and
// volumetric measurements. DOM-free so Node tests verify every rule.
import { index3D } from "@neurodesk/webapp-components/volume";
import { AXES } from "./config.js";
import { IMAGE_SIZE, LOW_RES_SIZE, sliceGeometry, sliceToRas } from "./volume.js";

const STABILITY_DELTA = 0.05;
const STABILITY_THRESH = 0.98;
const BOX_LABELS = [2, 3];

export function boxFromCorners([ax, ay], [bx, by], width, height) {
  const x0 = Math.round(Math.max(0, Math.min(ax, bx)));
  const y0 = Math.round(Math.max(0, Math.min(ay, by)));
  const x1 = Math.round(Math.min(width, Math.max(ax, bx)));
  const y1 = Math.round(Math.min(height, Math.max(ay, by)));
  return x1 > x0 && y1 > y0 ? [x0, y0, x1, y1] : null;
}

export function clickPixel(x, y, width, height) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  return px >= 0 && py >= 0 && px < width && py < height ? [px, py] : null;
}

export function hasPrompt(prompt) {
  return Boolean(prompt.box) || prompt.points.length > 0;
}

/**
 * SAM 2 prompt arrays in 512×512 model coordinates. Matches SAM2VideoPredictor.add_new_points_or_box:
 * box corners [x0, y0, x1, y1] with labels [2, 3] come FIRST, followed by any point clicks [x, y, 0|1].
 */
export function decoderInputs(prompt, width, height) {
  const coords = [];
  const labels = [];
  const sx = IMAGE_SIZE / width;
  const sy = IMAGE_SIZE / height;
  if (prompt.box) {
    const [x0, y0, x1, y1] = prompt.box;
    coords.push(x0 * sx, y0 * sy, x1 * sx, y1 * sy);
    labels.push(...BOX_LABELS);
  }
  for (const [x, y, label] of prompt.points) {
    coords.push(x * sx, y * sy);
    labels.push(label);
  }
  if (!labels.length) {
    coords.push(0, 0);
    labels.push(-1);
  }
  return {
    coords: Float32Array.from(coords),
    labels: Int32Array.from(labels),
    count: labels.length,
  };
}

/** Whether SAM 2 uses multimask output on an initial conditioning frame (1 point, no box). */
export function useMultimaskForPrompt(prompt) {
  const numPts = (prompt.box ? 2 : 0) + prompt.points.length;
  return numPts <= 1;
}

/** SAM 2 MaskDecoder._get_stability_scores for a single 128×128 logit plane. */
export function stabilityScore(logits, offset = 0, size = LOW_RES_SIZE * LOW_RES_SIZE, delta = STABILITY_DELTA) {
  let high = 0;
  let low = 0;
  for (let i = 0; i < size; i++) {
    const v = logits[offset + i];
    if (v > delta) high++;
    if (v > -delta) low++;
  }
  return low === 0 ? 1 : high / low;
}

/**
 * Exact port of SAM2Base._forward_sam_heads + MaskDecoder._dynamic_multimask_via_stability:
 * - When multimaskOutput is true (single click or tracking with 0 points): picks the highest-IoU
 *   token among tokens 1..3 for both mask and object pointer.
 * - When multimaskOutput is false (box or multi-point): checks token 0's stability score; if
 *   below 0.98, falls back to best of tokens 1..3 for the mask while always keeping token 0 for
 *   the object pointer (matching SAM 2's MaskDecoder.forward).
 */
export function selectMaskAndPtr(lowMasks, ious, objPtrs, multimaskOutput) {
  const plane = LOW_RES_SIZE * LOW_RES_SIZE;
  let bestMulti = 1;
  for (let t = 2; t < 4; t++) {
    if (ious[t] > ious[bestMulti]) bestMulti = t;
  }
  let maskToken;
  let ptrToken;
  if (multimaskOutput) {
    maskToken = bestMulti;
    ptrToken = bestMulti;
  } else {
    const stable = stabilityScore(lowMasks, 0, plane) >= STABILITY_THRESH;
    maskToken = stable ? 0 : bestMulti;
    ptrToken = 0;
  }
  const lowResLogits = lowMasks.slice(maskToken * plane, (maskToken + 1) * plane);
  const objPtr = objPtrs.slice(ptrToken * 256, (ptrToken + 1) * 256);
  return { lowResLogits, objPtr, score: ious[maskToken], token: maskToken };
}

/** Thresholds a float32 logit plane at 0 to a binary Uint8Array mask. */
export function thresholdMask(logits) {
  const mask = new Uint8Array(logits.length);
  for (let i = 0; i < logits.length; i++) mask[i] = logits[i] > 0 ? 1 : 0;
  return mask;
}

/**
 * Commits a Map<sliceIndex, Uint8Array> (binary 2D masks along `axis`) into the RAS 3D label
 * volume as `id` (1..255), preserving previously committed labels. Returns claimed 3D voxel indices.
 */
export function commitObject3D(labels3d, sliceMasks, dims, axis, id) {
  const { width, height } = sliceGeometry(dims, axis);
  const claimed = [];
  for (const [sliceIndex, mask] of sliceMasks.entries()) {
    for (let row = 0; row < height; row++) {
      for (let col = 0; col < width; col++) {
        if (!mask[row * width + col]) continue;
        const [x, y, z] = sliceToRas(col, row, sliceIndex, dims, axis);
        const at = index3D(x, y, z, dims);
        if (!labels3d[at]) {
          labels3d[at] = id;
          claimed.push(at);
        }
      }
    }
  }
  return Uint32Array.from(claimed);
}

export function uncommitObject(labels3d, claimed, id = null) {
  for (let i = 0; i < claimed.length; i++) {
    const at = claimed[i];
    if (id == null || labels3d[at] === id) labels3d[at] = 0;
  }
}

/**
 * Reconciles accepted object records with `labels3d` after manual mask editing so Undo, slice
 * counts and volumetric measurements reflect painted, overwritten or erased voxels accurately.
 */
export function reconcileObjectsFromLabels(labels3d, dims, existingObjects) {
  const [nx, ny, nz] = dims;
  const byId = new Map(existingObjects.map((obj) => [obj.id, obj]));
  const claimedMap = new Map();
  const slicesMap = new Map();
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const at = index3D(x, y, z, dims);
        const id = labels3d[at];
        if (!id) continue;
        let list = claimedMap.get(id);
        if (!list) {
          list = [];
          claimedMap.set(id, list);
          slicesMap.set(id, new Set());
        }
        list.push(at);
        const axis = byId.get(id)?.axis ?? "axial";
        slicesMap.get(id).add(axis === "coronal" ? y : axis === "sagittal" ? x : z);
      }
    }
  }
  const reconciled = [];
  for (const obj of existingObjects) {
    const list = claimedMap.get(obj.id);
    if (!list?.length) continue;
    reconciled.push({
      ...obj,
      claimed: Uint32Array.from(list),
      voxels: list.length,
      slices: slicesMap.get(obj.id).size,
    });
    claimedMap.delete(obj.id);
  }
  const extraIds = [...claimedMap.keys()].sort((a, b) => a - b);
  for (const id of extraIds) {
    const list = claimedMap.get(id);
    reconciled.push({
      id,
      claimed: Uint32Array.from(list),
      axis: "axial",
      slices: slicesMap.get(id).size,
      voxels: list.length,
      score: NaN,
      backend: "edited",
      prompt: { points: [], box: null },
    });
  }
  const maxId = reconciled.reduce((max, obj) => Math.max(max, obj.id), 0);
  return { objects: reconciled, nextId: maxId + 1 };
}

/** Volumetric measurements for every accepted label in RAS space. */
export function measureObjects3D(labels3d, dims, voxelVolumeOrPixDims, objects) {
  const [nx, ny, nz] = dims;
  const voxelMm3 = typeof voxelVolumeOrPixDims === "number"
    ? voxelVolumeOrPixDims
    : (voxelVolumeOrPixDims[0] || 1) * (voxelVolumeOrPixDims[1] || 1) * (voxelVolumeOrPixDims[2] || 1);
  const index = new Map(objects.map((object, i) => [object.id, i]));
  const stats = objects.map(() => ({
    voxels: 0,
    slices: new Set(),
    sx: 0,
    sy: 0,
    sz: 0,
    x0: Infinity,
    y0: Infinity,
    z0: Infinity,
    x1: -1,
    y1: -1,
    z1: -1,
  }));
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const at = index.get(labels3d[index3D(x, y, z, dims)]);
        if (at === undefined) continue;
        const s = stats[at];
        const axis = objects[at].axis ?? "axial";
        s.voxels++;
        s.slices.add(axis === "coronal" ? y : axis === "sagittal" ? x : z);
        s.sx += x;
        s.sy += y;
        s.sz += z;
        if (x < s.x0) s.x0 = x;
        if (y < s.y0) s.y0 = y;
        if (z < s.z0) s.z0 = z;
        if (x > s.x1) s.x1 = x;
        if (y > s.y1) s.y1 = y;
        if (z > s.z1) s.z1 = z;
      }
    }
  }
  return objects.map((object, at) => {
    const s = stats[at];
    const volumeMm3 = s.voxels * voxelMm3;
    return {
      id: object.id,
      voxels: s.voxels,
      volumeMm3,
      volumeMl: volumeMm3 / 1000,
      slices: s.slices.size,
      x: s.voxels ? s.sx / s.voxels : NaN,
      y: s.voxels ? s.sy / s.voxels : NaN,
      z: s.voxels ? s.sz / s.voxels : NaN,
      box: s.voxels ? [s.x0, s.y0, s.z0, s.x1 + 1, s.y1 + 1, s.z1 + 1] : [0, 0, 0, 0, 0, 0],
      axis: object.axis,
      prompt: object.prompt,
    };
  });
}

function promptSummary(prompt) {
  const positive = prompt.points.filter((point) => point[2] === 1).length;
  const negative = prompt.points.length - positive;
  return [prompt.box ? "box" : "", positive ? `${positive}+` : "", negative ? `${negative}-` : ""].filter(Boolean).join(" ") || "edited";
}

export function objectsTsv(rows) {
  const header = [
    "label",
    "voxels",
    "volume_mm3",
    "volume_ml",
    "slices",
    "centroid_x_vx",
    "centroid_y_vx",
    "centroid_z_vx",
    "bbox_x0_vx",
    "bbox_y0_vx",
    "bbox_z0_vx",
    "bbox_x1_vx",
    "bbox_y1_vx",
    "bbox_z1_vx",
    "axis",
    "prompt",
  ];
  const lines = [header.join("\t")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.voxels,
      row.volumeMm3.toFixed(2),
      row.volumeMl.toFixed(4),
      row.slices,
      row.x.toFixed(2),
      row.y.toFixed(2),
      row.z.toFixed(2),
      ...row.box,
      row.axis,
      promptSummary(row.prompt),
    ].join("\t"));
  }
  return `${lines.join("\n")}\n`;
}

export function maskIou(a, b) {
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) inter++;
    if (a[i] || b[i]) union++;
  }
  return union ? inter / union : 1;
}

/**
 * Parses automation prompts: JSON array of `{ axis?, slice, points?, box?, propagate?, range? }`.
 */
export function parsePrompts(text, dims) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("prompts must be a JSON array of prompt objects.");
  }
  if (!Array.isArray(value) || !value.length) throw new Error("prompts must list at least one object.");
  return value.map((item, n) => {
    const where = `Object ${n + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${where}: give { slice, points, box }.`);
    const axis = item.axis ?? "axial";
    if (!AXES.includes(axis)) throw new Error(`${where}: axis must be one of ${AXES.join(", ")}.`);
    const { width, height, depth } = sliceGeometry(dims, axis);
    const slice = item.slice ?? Math.floor(depth / 2);
    if (!Number.isInteger(slice) || slice < 0 || slice >= depth) {
      throw new Error(`${where}: slice ${slice} is outside 0..${depth - 1} for ${axis}.`);
    }
    const points = (item.points ?? []).map((point) => {
      if (!Array.isArray(point) || point.length !== 3) throw new Error(`${where}: each point is [x, y, label].`);
      const [x, y, label] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(`${where}: point (${x}, ${y}) is outside the ${width} × ${height} slice.`);
      }
      if (label !== 0 && label !== 1) throw new Error(`${where}: a point's label is 1 (positive) or 0 (negative).`);
      return [x, y, label];
    });
    let box = null;
    if (item.box != null) {
      if (!Array.isArray(item.box) || item.box.length !== 4 || !item.box.every(Number.isFinite)) {
        throw new Error(`${where}: box is [x0, y0, x1, y1].`);
      }
      box = boxFromCorners(item.box.slice(0, 2), item.box.slice(2), width, height);
      if (!box) throw new Error(`${where}: the box has no area inside the slice.`);
    }
    if (!points.length && !box) throw new Error(`${where}: give at least one point or a box.`);
    let range = [0, depth - 1];
    if (item.range != null) {
      if (!Array.isArray(item.range) || item.range.length !== 2 || !item.range.every(Number.isInteger)) {
        throw new Error(`${where}: range is [minSlice, maxSlice].`);
      }
      const [r0, r1] = item.range;
      if (r0 < 0 || r1 >= depth || r0 > slice || r1 < slice) {
        throw new Error(`${where}: range [${r0}, ${r1}] must include slice ${slice} within 0..${depth - 1}.`);
      }
      range = [r0, r1];
    }
    return { axis, slice, points, box, propagate: item.propagate !== false, range };
  });
}
