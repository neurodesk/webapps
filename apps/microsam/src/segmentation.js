// Prompts, mask choice, 3D box projection and the label volume, as micro-sam's
// prompt_based_segmentation and multi_dimensional_segmentation do them.
// DOM-free so Node tests can use it.
//
// A prompt is { points: [[x, y, label], …], box: [x0, y0, x1, y1] | null } in original pixel
// coordinates: x right and y down, points at pixel centres (integers, as napari gives them),
// boxes on pixel edges. label is 1 for a positive and 0 for a negative click.
import { toModelCoordinates } from "./preprocess.js";

const PAD_LABEL = -1;
const BOX_LABELS = [2, 3];

/** numpy.round: halves to the nearest even integer. */
export function roundHalfEven(value) {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction > 0.5) return floor + 1;
  if (fraction < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

/**
 * micro-sam's _process_box for a box dragged between two corners: ordered, clamped to the image
 * and rounded with numpy.round. Null when it has no area.
 */
export function boxFromCorners([ax, ay], [bx, by], width, height) {
  const box = [
    roundHalfEven(Math.max(Math.min(ax, bx), 0)),
    roundHalfEven(Math.max(Math.min(ay, by), 0)),
    roundHalfEven(Math.min(Math.max(ax, bx), width)),
    roundHalfEven(Math.min(Math.max(ay, by), height)),
  ];
  return box[2] > box[0] && box[3] > box[1] ? box : null;
}

/**
 * micro-sam's _compute_box_from_mask + _process_box: tight bounding box [x0, y0, x1, y1] of a
 * binary 2D mask, optionally expanded on each side by `boxExtension` times the box width/height,
 * clamped to the image and rounded with numpy.round. Null when the mask is empty.
 */
export function boxFromMask(mask, width, height, boxExtension = 0) {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const x = i % width;
    const y = (i - x) / width;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (maxX < minX) return null;
  const x0 = minX;
  const y0 = minY;
  const x1 = maxX + 1;
  const y1 = maxY + 1;
  const extX = boxExtension > 0 ? boxExtension * (x1 - x0) : 0;
  const extY = boxExtension > 0 ? boxExtension * (y1 - y0) : 0;
  return boxFromCorners([x0 - extX, y0 - extY], [x1 + extX, y1 + extY], width, height);
}

/** The pixel a click at continuous image coordinates lands on, or null outside the image. */
export function clickPixel(x, y, width, height) {
  const px = Math.floor(x);
  const py = Math.floor(y);
  return px >= 0 && py >= 0 && px < width && py < height ? [px, py] : null;
}

export function hasPrompt(prompt) {
  return Boolean(prompt.box) || prompt.points.length > 0;
}

/**
 * The decoder inputs for a prompt: SamPredictor's point transform, the box as two corner points
 * with labels 2 and 3, and the padding point SAM's prompt encoder adds when there is no box.
 */
export function decoderInputs(prompt, height, width) {
  const coords = [];
  const labels = [];
  for (const [x, y, label] of prompt.points) {
    coords.push(...toModelCoordinates([x, y], height, width));
    labels.push(label);
  }
  if (prompt.box) {
    const [x0, y0, x1, y1] = prompt.box;
    coords.push(...toModelCoordinates([x0, y0], height, width), ...toModelCoordinates([x1, y1], height, width));
    labels.push(...BOX_LABELS);
  } else {
    coords.push(0, 0);
    labels.push(PAD_LABEL);
  }
  return { coords: Float32Array.from(coords), labels: Float32Array.from(labels), count: labels.length };
}

/**
 * The mask token micro-sam keeps: for exactly one positive click and no box, the best of the
 * three multimask outputs by predicted IoU (segment_from_points' use_best_multimask); otherwise
 * the single-mask output, token 0.
 */
export function chooseToken(prompt, scores) {
  const single = !prompt.box && prompt.points.length === 1 && prompt.points[0][2] === 1;
  if (!single) return 0;
  let best = 1;
  for (let token = 2; token < scores.length; token++) if (scores[token] > scores[best]) best = token;
  return best;
}

/** One token's mask from the decoder's 1 × 4 × H × W logits: logits above 0 (mask_threshold). */
export function maskFromLogits(logits, token, height, width) {
  const plane = height * width;
  const mask = new Uint8Array(plane);
  const offset = token * plane;
  for (let i = 0; i < plane; i++) mask[i] = logits[offset + i] > 0 ? 1 : 0;
  return mask;
}

/**
 * Adds a 2D mask to the label image as object `id`. Pixels that already belong to an object keep
 * it (micro-sam's "pixels" preserve mode); returns the indices the object claimed.
 */
export function commitObject(labels, mask, id, offset = 0) {
  const claimed = [];
  for (let i = 0; i < mask.length; i++) {
    const at = offset + i;
    if (mask[i] && !labels[at]) {
      labels[at] = id;
      claimed.push(at);
    }
  }
  return Uint32Array.from(claimed);
}

/**
 * Adds a 3D object (`Map<sliceIndex, Uint8Array>`) to the 3D label volume as object `id`, keeping
 * previously accepted voxels intact. Returns the 3D voxel indices claimed.
 */
export function commitObject3D(labels, sliceMasks, planeSize, id) {
  const claimed = [];
  for (const [z, mask] of sliceMasks.entries()) {
    const offset = z * planeSize;
    for (let i = 0; i < mask.length; i++) {
      const at = offset + i;
      if (mask[i] && !labels[at]) {
        labels[at] = id;
        claimed.push(at);
      }
    }
  }
  return Uint32Array.from(claimed);
}

/** Removes an object committed by commitObject or commitObject3D. */
export function uncommitObject(labels, claimed) {
  for (const i of claimed) labels[i] = 0;
}

/**
 * Per-object measurements over the 2D label image: area, centroid (x right and y down from the
 * top-left pixel's centre), bounding box (exclusive end, as micro-sam's boxes) and the mean of
 * each plane given to the model.
 */
export function measureObjects(labels, width, planes, objects) {
  const index = new Map(objects.map((object, i) => [object.id, i]));
  const stats = objects.map(() => ({ area: 0, sx: 0, sy: 0, x0: Infinity, y0: Infinity, x1: -1, y1: -1, sums: planes.map(() => 0) }));
  for (let i = 0; i < labels.length; i++) {
    const at = index.get(labels[i]);
    if (at === undefined) continue;
    const s = stats[at];
    const x = i % width;
    const y = (i - x) / width;
    s.area++;
    s.sx += x;
    s.sy += y;
    if (x < s.x0) s.x0 = x;
    if (y < s.y0) s.y0 = y;
    if (x > s.x1) s.x1 = x;
    if (y > s.y1) s.y1 = y;
    planes.forEach((plane, c) => { s.sums[c] += plane.data[i]; });
  }
  return objects.map((object, at) => {
    const s = stats[at];
    return {
      id: object.id,
      area: s.area,
      x: s.area ? s.sx / s.area : NaN,
      y: s.area ? s.sy / s.area : NaN,
      box: s.area ? [s.x0, s.y0, s.x1 + 1, s.y1 + 1] : [0, 0, 0, 0],
      means: s.sums.map((sum) => (s.area ? sum / s.area : NaN)),
      score: object.score,
      prompt: object.prompt,
    };
  });
}

/**
 * Per-object measurements over a 3D label volume (Z × H × W): volume in voxels, slice count,
 * 3D centroid, 3D bounding box [x0, y0, z0, x1, y1, z1] (exclusive ends), and mean intensities.
 */
export function measureObjects3D(labels, width, height, depth, planesAt, objects) {
  const planeCount = planesAt(0).length;
  const planeSize = width * height;
  const index = new Map(objects.map((object, i) => [object.id, i]));
  const stats = objects.map(() => ({
    volume: 0,
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
    sums: Array.from({ length: planeCount }, () => 0),
  }));
  for (let z = 0; z < depth; z++) {
    const planes = planesAt(z);
    const offset = z * planeSize;
    for (let i = 0; i < planeSize; i++) {
      const at = index.get(labels[offset + i]);
      if (at === undefined) continue;
      const s = stats[at];
      const x = i % width;
      const y = (i - x) / width;
      s.volume++;
      s.slices.add(z);
      s.sx += x;
      s.sy += y;
      s.sz += z;
      if (x < s.x0) s.x0 = x;
      if (y < s.y0) s.y0 = y;
      if (z < s.z0) s.z0 = z;
      if (x > s.x1) s.x1 = x;
      if (y > s.y1) s.y1 = y;
      if (z > s.z1) s.z1 = z;
      for (let c = 0; c < planeCount; c++) s.sums[c] += planes[c].data[i];
    }
  }
  return objects.map((object, at) => {
    const s = stats[at];
    return {
      id: object.id,
      volume: s.volume,
      slices: s.slices.size,
      x: s.volume ? s.sx / s.volume : NaN,
      y: s.volume ? s.sy / s.volume : NaN,
      z: s.volume ? s.sz / s.volume : NaN,
      box: s.volume ? [s.x0, s.y0, s.z0, s.x1 + 1, s.y1 + 1, s.z1 + 1] : [0, 0, 0, 0, 0, 0],
      means: s.sums.map((sum) => (s.volume ? sum / s.volume : NaN)),
      score: object.score,
      prompt: object.prompt,
    };
  });
}

function promptSummary(prompt) {
  const positive = prompt.points.filter((point) => point[2] === 1).length;
  const negative = prompt.points.length - positive;
  return [prompt.box ? "box" : "", positive ? `${positive}+` : "", negative ? `${negative}-` : ""].filter(Boolean).join(" ");
}

function meanHeaders(planes) {
  return planes.length === 1 ? ["mean_intensity"] : planes.map((plane, c) => `mean_${plane.kind?.match(/^(red|green|blue)$/) ? plane.kind : `channel${c + 1}`}`);
}

/** The per-object table for 2D images: one row per accepted object, ids as in the label image. */
export function objectsCsv(rows, planes) {
  const header = ["id", "area_px", "centroid_x", "centroid_y", "bbox_x0", "bbox_y0", "bbox_x1", "bbox_y1", ...meanHeaders(planes), "predicted_iou", "prompt"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.area,
      row.x.toFixed(3),
      row.y.toFixed(3),
      ...row.box,
      ...row.means.map((mean) => mean.toPrecision(7)),
      row.score.toFixed(4),
      promptSummary(row.prompt),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** The per-object table for 3D Z-stacks: one row per accepted 3D object. */
export function objectsCsv3D(rows, planes) {
  const header = ["id", "volume_vx", "slices", "centroid_x", "centroid_y", "centroid_z", "bbox_x0", "bbox_y0", "bbox_z0", "bbox_x1", "bbox_y1", "bbox_z1", ...meanHeaders(planes), "predicted_iou", "prompt"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push([
      row.id,
      row.volume,
      row.slices,
      row.x.toFixed(3),
      row.y.toFixed(3),
      row.z.toFixed(3),
      ...row.box,
      ...row.means.map((mean) => mean.toPrecision(7)),
      row.score.toFixed(4),
      promptSummary(row.prompt),
    ].join(","));
  }
  return `${lines.join("\n")}\n`;
}

/** Run lengths over a row-major mask, starting with a background run (validation/reference.py). */
export function maskRuns(mask) {
  const runs = [];
  let value = 0;
  let length = 0;
  for (let i = 0; i < mask.length; i++) {
    if ((mask[i] ? 1 : 0) === value) {
      length++;
    } else {
      runs.push(length);
      value = 1 - value;
      length = 1;
    }
  }
  runs.push(length);
  return runs;
}

export function maskFromRuns(runs, size) {
  const mask = new Uint8Array(size);
  let at = 0;
  runs.forEach((length, index) => {
    if (index % 2) mask.fill(1, at, at + length);
    at += length;
  });
  return mask;
}

export function maskIou(a, b) {
  let intersection = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && b[i]) intersection++;
    if (a[i] || b[i]) union++;
  }
  return union ? intersection / union : 1;
}

/**
 * The automation contract's prompts: a JSON array with one { points, box, slice?, propagate? }
 * entry per object, in the coordinates above. Boxes are ordered, clamped and rounded as a dragged
 * box is.
 */
export function parsePrompts(text, width, height, depth = 1) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("prompts must be a JSON array of { points, box } objects.");
  }
  if (!Array.isArray(value) || !value.length) throw new Error("prompts must list at least one object.");
  return value.map((item, n) => {
    const where = `Object ${n + 1}`;
    if (!item || typeof item !== "object") throw new Error(`${where}: give { points, box }.`);
    const points = (item.points ?? []).map((point) => {
      if (!Array.isArray(point) || point.length !== 3) throw new Error(`${where}: each point is [x, y, label].`);
      const [x, y, label] = point;
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= width || y >= height) {
        throw new Error(`${where}: point (${x}, ${y}) is outside the ${width} × ${height} image.`);
      }
      if (label !== 0 && label !== 1) throw new Error(`${where}: a point's label is 1 (positive) or 0 (negative).`);
      return [x, y, label];
    });
    let box = null;
    if (item.box != null) {
      if (!Array.isArray(item.box) || item.box.length !== 4 || !item.box.every(Number.isFinite)) throw new Error(`${where}: box is [x0, y0, x1, y1].`);
      box = boxFromCorners(item.box.slice(0, 2), item.box.slice(2), width, height);
      if (!box) throw new Error(`${where}: the box has no area inside the image.`);
    }
    if (!points.length && !box) throw new Error(`${where}: give at least one point or a box.`);
    let slice = 0;
    if (item.slice !== undefined) {
      if (!Number.isInteger(item.slice) || item.slice < 0 || item.slice >= depth) {
        throw new Error(`${where}: slice ${item.slice} is outside 0..${depth - 1}.`);
      }
      slice = item.slice;
    }
    const parsed = { points, box };
    if (item.slice !== undefined || depth > 1) parsed.slice = slice;
    if (item.propagate !== undefined) parsed.propagate = Boolean(item.propagate);
    return parsed;
  });
}
