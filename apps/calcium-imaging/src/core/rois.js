// ROI detection on the local correlation image: a deliberately simple, documented method that
// is not Suite2p's or CNMF's, and finds cells that are active during the recording. The
// threshold is robust: t = median + z · 1.4826 · MAD of the correlation image. Seeds are local
// maxima at or above t, at least a cell radius apart. Each seed grows by marker-controlled
// watershed (Meyer flooding of −correlation, 4-connected) over pixels at or above
// median + (z/2) · 1.4826 · MAD and no farther than one cell diameter from its seed. Regions
// outside [π(d/4)², π d²] pixels are dropped. Labels are 1…n in raster order of each kept
// region's first pixel (row by row, top left first), not in seed strength.
// A border band of `margin` pixels is left out: after motion correction its pixels are copies
// of the edge (replicated borders), so neighbouring pixels there correlate perfectly.

class MinHeap {
  constructor() {
    this.keys = [];
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(key, item) {
    const keys = this.keys;
    const items = this.items;
    let i = items.length;
    keys.push(key);
    items.push(item);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!less(keys[i], keys[parent])) break;
      [keys[i], keys[parent]] = [keys[parent], keys[i]];
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  pop() {
    const keys = this.keys;
    const items = this.items;
    const top = items[0];
    const lastKey = keys.pop();
    const lastItem = items.pop();
    if (items.length) {
      keys[0] = lastKey;
      items[0] = lastItem;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && less(keys[left], keys[smallest])) smallest = left;
        if (right < items.length && less(keys[right], keys[smallest])) smallest = right;
        if (smallest === i) break;
        [keys[i], keys[smallest]] = [keys[smallest], keys[i]];
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

// Keys are [priority, insertion order], so equal priorities flood first-in first-out.
function less(a, b) {
  return a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
}

function median(values) {
  const sorted = Float64Array.from(values).sort();
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** The median and the robust standard deviation 1.4826 · MAD of an image (inside `margin`). */
export function robustLevel(image, height = 1, width = image.length, margin = 0) {
  const values = [];
  for (let y = margin; y < height - margin; y++) for (let x = margin; x < width - margin; x++) values.push(image[y * width + x]);
  if (!values.length) throw new Error("The border band left out of ROI detection covers the whole image.");
  const centre = median(values);
  const spread = 1.4826 * median(Float64Array.from(values, (value) => Math.abs(value - centre)));
  return { median: centre, sigma: spread };
}

/** Local maxima at or above `threshold`, strongest first, no two closer than `radius`. */
export function findSeeds(image, height, width, { threshold, radius, margin = 0 }) {
  const r = Math.max(1, Math.round(radius));
  const candidates = [];
  for (let y = margin; y < height - margin; y++) {
    for (let x = margin; x < width - margin; x++) {
      const value = image[y * width + x];
      if (!(value >= threshold)) continue;
      let peak = true;
      for (let dy = -r; dy <= r && peak; dy++) {
        const yy = y + dy;
        // Neighbours in the excluded border band (replicated edges after motion correction)
        // must not suppress a seed just inside the usable area.
        if (yy < margin || yy >= height - margin) continue;
        for (let dx = -r; dx <= r; dx++) {
          const xx = x + dx;
          if (xx < margin || xx >= width - margin || (dx === 0 && dy === 0)) continue;
          if (image[yy * width + xx] > value) {
            peak = false;
            break;
          }
        }
      }
      if (peak) candidates.push({ y, x, value });
    }
  }
  candidates.sort((a, b) => b.value - a.value || a.y - b.y || a.x - b.x);
  const seeds = [];
  for (const candidate of candidates) {
    if (seeds.every((seed) => (seed.y - candidate.y) ** 2 + (seed.x - candidate.x) ** 2 >= r * r)) seeds.push(candidate);
  }
  return seeds;
}

/** The watershed of −image from `seeds`, as a Uint16 label image (0 = background). */
export function watershed(image, height, width, seeds, { floor, maxDistance, margin = 0 }) {
  const labels = new Uint16Array(height * width);
  const heap = new MinHeap();
  let order = 0;
  const maxDistance2 = maxDistance * maxDistance;
  seeds.forEach((seed, index) => {
    const i = seed.y * width + seed.x;
    labels[i] = index + 1;
    heap.push([-image[i], order++], i);
  });
  while (heap.size) {
    const i = heap.pop();
    const label = labels[i];
    const seed = seeds[label - 1];
    const y = (i / width) | 0;
    const x = i - y * width;
    for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const yy = y + dy;
      const xx = x + dx;
      if (yy < margin || yy >= height - margin || xx < margin || xx >= width - margin) continue;
      const j = yy * width + xx;
      if (labels[j] || !(image[j] >= floor)) continue;
      if ((yy - seed.y) ** 2 + (xx - seed.x) ** 2 > maxDistance2) continue;
      labels[j] = label;
      heap.push([-image[j], order++], j);
    }
  }
  return labels;
}

/** Renumbers labels 1…n in order of first appearance of the kept labels. */
export function relabel(labels, keep = () => true) {
  const map = new Map();
  const out = new Uint16Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    const label = labels[i];
    if (!label || !keep(label)) continue;
    if (!map.has(label)) map.set(label, map.size + 1);
    out[i] = map.get(label);
  }
  return out;
}

export function labelAreas(labels) {
  const areas = new Map();
  for (const label of labels) if (label) areas.set(label, (areas.get(label) ?? 0) + 1);
  return areas;
}

/**
 * Detects cell-sized ROIs in a correlation image.
 * @param {Float32Array} correlation
 * @param {{ z: number, diameter: number }} options robust threshold and cell diameter in pixels
 */
export function detectRois(correlation, height, width, { z, diameter, margin = 0 }) {
  const level = robustLevel(correlation, height, width, margin);
  const threshold = level.median + z * level.sigma;
  const floor = level.median + (z / 2) * level.sigma;
  // A correlation image without contrast (a blank or constant movie) has no cells to find.
  if (!(level.sigma > 0)) return { labels: new Uint16Array(height * width), threshold, floor, margin, seeds: 0 };
  const seeds = findSeeds(correlation, height, width, { threshold, radius: diameter / 2, margin });
  const grown = watershed(correlation, height, width, seeds, { floor, maxDistance: diameter, margin });
  const areas = labelAreas(grown);
  const minArea = Math.PI * (diameter / 4) ** 2;
  const maxArea = Math.PI * diameter ** 2;
  const labels = relabel(grown, (label) => areas.get(label) >= minArea && areas.get(label) <= maxArea);
  return { labels, threshold, floor, margin, seeds: seeds.length };
}

/** Adds a disc ROI of `diameter` at (y, x); pixels already in an ROI keep their label. */
export function addDiscRoi(labels, height, width, { y, x, diameter }) {
  const out = Uint16Array.from(labels);
  let next = 0;
  for (const label of labels) if (label > next) next = label;
  next += 1;
  const r = diameter / 2;
  let added = 0;
  for (let yy = Math.floor(y - r); yy <= Math.ceil(y + r); yy++) {
    for (let xx = Math.floor(x - r); xx <= Math.ceil(x + r); xx++) {
      if (yy < 0 || yy >= height || xx < 0 || xx >= width) continue;
      if ((yy - y) ** 2 + (xx - x) ** 2 > r * r) continue;
      const i = yy * width + xx;
      if (out[i]) continue;
      out[i] = next;
      added++;
    }
  }
  return { labels: out, added: added ? next : 0 };
}

/** Removes the ROI under (y, x) and renumbers the rest; returns the removed label (0 if none). */
export function removeRoiAt(labels, width, { y, x }) {
  const removed = labels[y * width + x];
  if (!removed) return { labels, removed: 0 };
  return { labels: relabel(labels, (label) => label !== removed), removed };
}
