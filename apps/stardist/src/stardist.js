// StarDist 2D post-processing and tiling, ported from StarDist 0.9.1 and csbdeep 0.8.1.
// Pure and DOM-free: the worker and the Node tests import it. Every function names the
// Python (or C++) it reproduces; validation/reference.json holds that code's results.
import ClipperLib from "clipper-lib";

const f32 = Math.fround;

/** numpy.percentile(values, p) with the default linear method (numpy 1.26 `_lerp`). */
export function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  const index = (p / 100) * (sorted.length - 1);
  const below = Math.floor(index);
  const above = Math.min(below + 1, sorted.length - 1);
  const t = index - below;
  const a = sorted[below];
  const b = sorted[above];
  const diff = b - a;
  return t >= 0.5 ? b - diff * (1 - t) : a + diff * t;
}

/**
 * csbdeep.utils.normalize(x, pmin, pmax): float32 (x - lo) / (hi - lo + 1e-20), with the
 * percentiles of the whole image.
 */
export function normalize(values, pmin, pmax) {
  const low = f32(percentile(values, pmin));
  const high = f32(percentile(values, pmax));
  const scale = f32(f32(high - low) + f32(1e-20));
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) out[i] = f32(f32(values[i]) - low) / scale;
  return { data: out, low, high };
}

/** numpy.pad(x, (0, pad), mode="reflect") index for position i of an axis of length n. */
function reflect(i, n) {
  if (n === 1) return 0;
  const period = 2 * (n - 1);
  const k = i % period;
  return k < n ? k : period - k;
}

/** StarDistPadAndCropResizer.before: reflect-pad the end of each axis to a multiple of `divBy`. */
export function padImage(data, height, width, divBy) {
  const padHeight = height + ((divBy - (height % divBy)) % divBy);
  const padWidth = width + ((divBy - (width % divBy)) % divBy);
  if (padHeight === height && padWidth === width) return { data, height, width };
  const out = new Float32Array(padHeight * padWidth);
  for (let y = 0; y < padHeight; y++) {
    const row = reflect(y, height) * width;
    for (let x = 0; x < padWidth; x++) out[y * padWidth + x] = data[row + reflect(x, width)];
  }
  return { data: out, height: padHeight, width: padWidth };
}

/** csbdeep Tile: one tile of `size` blocks after `prev` along an axis of `n` blocks. */
function tile(n, size, overlap, prev) {
  if (n < size) {
    size = n;
    overlap = 0;
  }
  let read;
  if (!prev) {
    read = [0, size];
  } else {
    let start = prev.read[1] - 2 * overlap;
    let stop = start + size;
    const shift = Math.min(0, n - stop);
    start += shift;
    stop += shift;
    read = [start, stop];
  }
  const atEnd = read[1] === n;
  let write;
  if (!prev) write = atEnd ? [0, n] : [0, size - overlap];
  else if (atEnd) write = [prev.write[1], n];
  else write = [prev.write[1], prev.write[1] + size - 2 * overlap];
  return { read, write, atEnd };
}

function tiling(n, size, overlap) {
  const tiles = [tile(n, size, overlap, null)];
  while (!tiles.at(-1).atEnd) tiles.push(tile(n, size, overlap, tiles.at(-1)));
  return tiles;
}

/**
 * csbdeep Tiling.for_n_tiles(n, nTiles, overlap).slice_generator(block): the tiles of one axis
 * of `size` pixels, each with `read` (input range), `write` (output range) and `crop` (the
 * part of the tile that is written), in pixels.
 */
export function axisTiles(size, nTiles, block, overlapBlocks) {
  const n = size / block;
  const smallest = 2 * overlapBlocks + 1;
  let tileSize = smallest;
  while (tiling(n, tileSize, overlapBlocks).length > nTiles) tileSize++;
  let chosen = tiling(n, tileSize, overlapBlocks);
  if (tileSize !== smallest) {
    const smaller = tiling(n, tileSize - 1, overlapBlocks);
    if (Math.abs(smaller.length - nTiles) <= Math.abs(chosen.length - nTiles)) chosen = smaller;
  }
  return chosen.map(({ read, write }) => {
    const r = [read[0] * block, read[1] * block];
    const w = [write[0] * block, write[1] * block];
    const stop = w[1] - r[1];
    return { read: r, write: w, crop: [w[0] - r[0], stop < 0 ? stop : null] };
  });
}

/** The tile counts StarDist predicts with when the user leaves tiling on automatic. */
export function automaticTiles(height, width, maxTile = 1024) {
  return [Math.max(1, Math.ceil(height / maxTile)), Math.max(1, Math.ceil(width / maxTile))];
}

/**
 * StarDist2D._predict_sparse_generator: run the network on the padded image (tiled as csbdeep
 * tiles it), keep the grid pixels whose probability exceeds `probThresh` (not within `b` grid
 * pixels of the padded image border) and inside the unpadded image.
 *
 * `run(tile, height, width)` returns `{ prob, dist }` for one tile: prob has
 * (height / grid) × (width / grid) values and dist nRays per grid pixel (NHWC).
 */
export async function predictCandidates(image, height, width, model, options) {
  const { probThresh, nTiles = [1, 1], run, onTile = () => {}, signal } = options;
  const { grid, divBy, tileOverlap, nRays } = model;
  const padded = padImage(image, height, width, divBy);
  const overlapBlocks = tileOverlap.map((overlap) => Math.ceil(overlap / divBy));
  const tilesY = axisTiles(padded.height, nTiles[0], divBy, overlapBlocks[0]);
  const tilesX = axisTiles(padded.width, nTiles[1], divBy, overlapBlocks[1]);
  const gridHeight = padded.height / grid;
  const gridWidth = padded.width / grid;
  const threshold = f32(probThresh);
  const prob = [];
  const dist = [];
  const points = [];
  const total = tilesY.length * tilesX.length;
  let done = 0;
  for (const ty of tilesY) {
    for (const tx of tilesX) {
      signal?.throwIfAborted();
      const tileHeight = ty.read[1] - ty.read[0];
      const tileWidth = tx.read[1] - tx.read[0];
      const input = new Float32Array(tileHeight * tileWidth);
      for (let y = 0; y < tileHeight; y++) {
        const from = (ty.read[0] + y) * padded.width + tx.read[0];
        input.set(padded.data.subarray(from, from + tileWidth), y * tileWidth);
      }
      const output = await run(input, tileHeight, tileWidth);
      const outWidth = tileWidth / grid;
      const sliceY = cropStop(ty, tileHeight, grid);
      const sliceX = cropStop(tx, tileWidth, grid);
      const dstY = [ty.write[0] / grid, ty.write[1] / grid];
      const dstX = [tx.write[0] / grid, tx.write[1] / grid];
      // _ind_prob_thresh with b only on the sides that touch the padded image border.
      const b = 2;
      const y0 = sliceY[0] + (dstY[0] === 0 ? b : 0);
      const y1 = sliceY[1] - (dstY[1] === gridHeight ? b : 0);
      const x0 = sliceX[0] + (dstX[0] === 0 ? b : 0);
      const x1 = sliceX[1] - (dstX[1] === gridWidth ? b : 0);
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const at = y * outWidth + x;
          const p = output.prob[at];
          if (!(p > threshold)) continue;
          const py = (dstY[0] + y - sliceY[0]) * grid;
          const px = (dstX[0] + x - sliceX[0]) * grid;
          if (py >= height || px >= width) continue;
          prob.push(p);
          points.push(py, px);
          for (let k = 0; k < nRays; k++) dist.push(Math.max(f32(1e-3), output.dist[at * nRays + k]));
        }
      }
      onTile(++done, total);
    }
  }
  return { prob: Float32Array.from(prob), dist: Float32Array.from(dist), points: Int32Array.from(points), tiles: total };
}

function cropStop(axis, tileSize, grid) {
  const start = axis.crop[0] / grid;
  const stop = axis.crop[1] === null ? tileSize / grid : (tileSize + axis.crop[1]) / grid;
  return [start, stop];
}

/** Candidate order of StarDist's NMS: probability descending (np.argsort(prob)[::-1]). */
export function descendingOrder(prob) {
  const order = Array.from(prob, (_, i) => i);
  order.sort((a, b) => prob[b] - prob[a] || b - a);
  return order;
}

/** area_from_path in stardist2d.cpp: float accumulation of the integer shoelace terms. */
function pathArea(path) {
  let area = 0;
  const n = path.length;
  for (let i = 0; i < n; i++) {
    const a = path[i];
    const b = path[(i + 1) % n];
    area = f32(area + f32(a.X * b.Y - a.Y * b.X));
  }
  return f32(0.5 * Math.abs(area));
}

function intersectionArea(a, b) {
  const clipper = new ClipperLib.Clipper();
  const solution = new ClipperLib.Paths();
  clipper.AddPath(a, ClipperLib.PolyType.ptClip, true);
  clipper.AddPath(b, ClipperLib.PolyType.ptSubject, true);
  clipper.Execute(ClipperLib.ClipType.ctIntersection, solution, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
  let area = 0;
  for (const path of solution) area = f32(area + pathArea(path));
  return area;
}

/**
 * c_non_max_suppression_inds (stardist2d.cpp) with use_bbox and use_kdtree: polygon i
 * suppresses a later polygon j when their intersection over the smaller area exceeds
 * `threshold`. `dist` (n × nRays) and `points` (n × 2, row then column) must already be in
 * descending probability order. Returns the indices that survive, in that order.
 */
export function suppress(dist, points, nRays, threshold, { signal } = {}) {
  const n = points.length / 2;
  const angle = f32((2 * Math.PI) / nRays);
  const paths = new Array(n);
  const areas = new Float32Array(n);
  const bbox = new Float32Array(4 * n);
  const radius = new Float32Array(n);
  let maxRadius = 0;
  for (let i = 0; i < n; i++) {
    const py = f32(points[2 * i]);
    const px = f32(points[2 * i + 1]);
    const path = [];
    let outer = 0;
    for (let k = 0; k < nRays; k++) {
      const d = dist[i * nRays + k];
      const phi = f32(angle * k);
      const y = f32(py + f32(d * f32(Math.sin(phi))));
      const x = f32(px + f32(d * f32(Math.cos(phi))));
      if (k === 0) {
        bbox[4 * i] = x;
        bbox[4 * i + 1] = x;
        bbox[4 * i + 2] = y;
        bbox[4 * i + 3] = y;
      } else {
        bbox[4 * i] = Math.min(bbox[4 * i], x);
        bbox[4 * i + 1] = Math.max(bbox[4 * i + 1], x);
        bbox[4 * i + 2] = Math.min(bbox[4 * i + 2], y);
        bbox[4 * i + 3] = Math.max(bbox[4 * i + 3], y);
      }
      path.push(new ClipperLib.IntPoint(Math.trunc(x), Math.trunc(y)));
      outer = Math.max(d, outer);
    }
    radius[i] = outer;
    maxRadius = Math.max(maxRadius, outer);
    paths[i] = path;
    areas[i] = pathArea(path);
  }

  // A uniform grid replaces nanoflann's kd-tree; both list the candidates whose centre lies
  // within (max radius + own radius) of polygon i, which is all the loop below may touch.
  const cell = Math.max(1, 2 * maxRadius);
  const cells = new Map();
  for (let i = 0; i < n; i++) {
    const key = `${Math.floor(points[2 * i] / cell)},${Math.floor(points[2 * i + 1] / cell)}`;
    if (!cells.has(key)) cells.set(key, []);
    cells.get(key).push(i);
  }
  const suppressed = new Uint8Array(n);
  const limit = f32(threshold);
  for (let i = 0; i < n - 1; i++) {
    if (suppressed[i]) continue;
    if ((i & 255) === 0) signal?.throwIfAborted();
    const reach = f32(maxRadius + radius[i]);
    const reach2 = f32(reach * reach);
    const cy = Math.floor(points[2 * i] / cell);
    const cx = Math.floor(points[2 * i + 1] / cell);
    const span = Math.ceil(reach / cell);
    for (let gy = cy - span; gy <= cy + span; gy++) {
      for (let gx = cx - span; gx <= cx + span; gx++) {
        const members = cells.get(`${gy},${gx}`);
        if (!members) continue;
        for (const j of members) {
          if (j <= i || suppressed[j]) continue;
          const dy = f32(points[2 * i] - points[2 * j]);
          const dx = f32(points[2 * i + 1] - points[2 * j + 1]);
          if (!(f32(f32(dy * dy) + f32(dx * dx)) < reach2)) continue;
          if (!(bbox[4 * j] <= bbox[4 * i + 1] && bbox[4 * i] <= bbox[4 * j + 1] && bbox[4 * j + 2] <= bbox[4 * i + 3] && bbox[4 * i + 2] <= bbox[4 * j + 3])) continue;
          const inter = intersectionArea(paths[i], paths[j]);
          const overlap = f32(inter / Math.min(areas[i] + 1e-10, areas[j] + 1e-10));
          if (overlap > limit) suppressed[j] = 1;
        }
      }
    }
  }
  const kept = [];
  for (let i = 0; i < n; i++) if (!suppressed[i]) kept.push(i);
  return kept;
}

/** ray_angles(n) = np.linspace(0, 2π, n, endpoint=False). */
function rayAngles(nRays) {
  const step = (2 * Math.PI) / nRays;
  return Array.from({ length: nRays }, (_, k) => k * step);
}

/** dist_to_coord: float32 polygon vertices, rows then columns, for each polygon. */
export function polygonCoordinates(dist, points, nRays) {
  const n = points.length / 2;
  const phis = rayAngles(nRays);
  const sin = phis.map(Math.sin);
  const cos = phis.map(Math.cos);
  const coord = new Float32Array(n * 2 * nRays);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < nRays; k++) {
      const d = dist[i * nRays + k];
      coord[(2 * i) * nRays + k] = f32(f32(d * sin[k]) + points[2 * i]);
      coord[(2 * i + 1) * nRays + k] = f32(f32(d * cos[k]) + points[2 * i + 1]);
    }
  }
  return coord;
}

/** skimage.measure.points_in_poly test (O'Rourke): nonzero for inside, edge or vertex. */
function pointInPolygon(xs, ys, x, y) {
  const n = xs.length;
  let x1 = xs[n - 1] - x;
  let y1 = ys[n - 1] - y;
  let right = 0;
  let left = 0;
  for (let i = 0; i < n; i++) {
    const x0 = xs[i] - x;
    const y0 = ys[i] - y;
    if (-1e-12 < x0 && x0 < 1e-12 && -1e-12 < y0 && y0 < 1e-12) return true;
    if ((y0 > 0) !== (y1 > 0) && (x0 * y1 - x1 * y0) / (y1 - y0) > 0) right++;
    if ((y0 < 0) !== (y1 < 0) && (x0 * y1 - x1 * y0) / (y1 - y0) < 0) left++;
    x1 = x0;
    y1 = y0;
  }
  return (right & 1) !== (left & 1) || (right & 1) === 1;
}

/**
 * polygons_to_label: draw each polygon with skimage.draw.polygon in ascending (stable) order of
 * probability, so a more probable polygon wins where two overlap. Polygon i gets label i + 1;
 * NMS leaves them in descending order, so label k is the k-th most probable nucleus.
 */
export function renderLabels(coord, prob, nRays, height, width) {
  const labels = new Int32Array(height * width);
  const order = Array.from(prob, (_, i) => i).sort((a, b) => prob[a] - prob[b] || a - b);
  for (const i of order) {
    const rows = Float64Array.from(coord.subarray(2 * i * nRays, (2 * i + 1) * nRays));
    const cols = Float64Array.from(coord.subarray((2 * i + 1) * nRays, (2 * i + 2) * nRays));
    let minRow = Infinity;
    let maxRow = -Infinity;
    let minCol = Infinity;
    let maxCol = -Infinity;
    for (let k = 0; k < nRays; k++) {
      minRow = Math.min(minRow, rows[k]);
      maxRow = Math.max(maxRow, rows[k]);
      minCol = Math.min(minCol, cols[k]);
      maxCol = Math.max(maxCol, cols[k]);
    }
    const r0 = Math.trunc(Math.max(0, minRow));
    const r1 = Math.min(height - 1, Math.ceil(maxRow));
    const c0 = Math.trunc(Math.max(0, minCol));
    const c1 = Math.min(width - 1, Math.ceil(maxCol));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (pointInPolygon(cols, rows, c, r)) labels[r * width + c] = i + 1;
      }
    }
  }
  return labels;
}

/** Per-nucleus measurements as skimage regionprops gives them: centroid (x, y), area, mean. */
export function measureNuclei(labels, image, width, count) {
  const area = new Float64Array(count + 1);
  const sumX = new Float64Array(count + 1);
  const sumY = new Float64Array(count + 1);
  const sum = new Float64Array(count + 1);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label) continue;
    area[label]++;
    sumX[label] += i % width;
    sumY[label] += Math.floor(i / width);
    sum[label] += image[i];
  }
  const rows = [];
  for (let label = 1; label <= count; label++) {
    if (!area[label]) continue;
    rows.push({ id: label, x: sumX[label] / area[label], y: sumY[label] / area[label], area: area[label], mean: sum[label] / area[label] });
  }
  return rows;
}

/** The full StarDist 2D instance segmentation: predictCandidates, NMS, labels and measurements. */
export async function segment(raw, height, width, model, options) {
  const { pmin = 1, pmax = 99.8, probThresh = model.thresholds.prob, nmsThresh = model.thresholds.nms, onStage = () => {}, signal } = options;
  const normalized = normalize(raw, pmin, pmax);
  const candidates = await predictCandidates(normalized.data, height, width, model, { ...options, probThresh });
  onStage("nms", candidates.prob.length);
  const order = descendingOrder(candidates.prob);
  const { nRays } = model;
  const dist = new Float32Array(order.length * nRays);
  const points = new Int32Array(order.length * 2);
  order.forEach((from, to) => {
    dist.set(candidates.dist.subarray(from * nRays, (from + 1) * nRays), to * nRays);
    points[2 * to] = candidates.points[2 * from];
    points[2 * to + 1] = candidates.points[2 * from + 1];
  });
  const kept = suppress(dist, points, nRays, nmsThresh, { signal });
  const keptDist = new Float32Array(kept.length * nRays);
  const keptPoints = new Int32Array(kept.length * 2);
  const keptProb = new Float32Array(kept.length);
  kept.forEach((from, to) => {
    keptDist.set(dist.subarray(from * nRays, (from + 1) * nRays), to * nRays);
    keptPoints[2 * to] = points[2 * from];
    keptPoints[2 * to + 1] = points[2 * from + 1];
    keptProb[to] = candidates.prob[order[from]];
  });
  onStage("labels", kept.length);
  const coord = polygonCoordinates(keptDist, keptPoints, nRays);
  const labels = renderLabels(coord, keptProb, nRays, height, width);
  const nuclei = measureNuclei(labels, raw, width, kept.length).map((row) => ({ ...row, probability: keptProb[row.id - 1] }));
  return {
    labels,
    nuclei,
    count: kept.length,
    candidates: candidates.prob.length,
    tiles: candidates.tiles,
    normalization: { low: normalized.low, high: normalized.high },
    polygons: { points: keptPoints, prob: keptProb, coord },
  };
}
