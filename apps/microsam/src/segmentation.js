// Prompts, mask choice and the label image, as micro-sam's prompt_based_segmentation does them.
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
 * Adds a mask to the label image as object `id`. Pixels that already belong to an object keep
 * it (micro-sam's "pixels" preserve mode); returns the indices the object claimed.
 */
export function commitObject(labels, mask, id) {
  const claimed = [];
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] && !labels[i]) {
      labels[i] = id;
      claimed.push(i);
    }
  }
  return Uint32Array.from(claimed);
}

/** Removes an object committed by commitObject. */
export function uncommitObject(labels, claimed) {
  for (const i of claimed) labels[i] = 0;
}

/**
 * Per-object measurements over the label image: area, centroid (x right and y down from the
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

function promptSummary(prompt) {
  const positive = prompt.points.filter((point) => point[2] === 1).length;
  const negative = prompt.points.length - positive;
  return [prompt.box ? "box" : "", positive ? `${positive}+` : "", negative ? `${negative}-` : ""].filter(Boolean).join(" ");
}

/** The per-object table: one row per accepted object, ids as in the label image. */
export function objectsCsv(rows, planes) {
  const means = planes.length === 1 ? ["mean_intensity"] : planes.map((plane, c) => `mean_${plane.kind?.match(/^(red|green|blue)$/) ? plane.kind : `channel${c + 1}`}`);
  const header = ["id", "area_px", "centroid_x", "centroid_y", "bbox_x0", "bbox_y0", "bbox_x1", "bbox_y1", ...means, "predicted_iou", "prompt"];
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
 * The automation contract's prompts: a JSON array with one { points, box } entry per object, in
 * the coordinates above. Boxes are ordered, clamped and rounded as a dragged box is.
 */
export function parsePrompts(text, width, height) {
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
    return { points, box };
  });
}
