// Morphometry, outline generation, and instance-segmentation parity metrics for InstanSeg.

/** Compute per-nucleus morphometry (id, centroid, area in px and optional µm², equivalent diameter, bbox). */
export function measureNuclei(labels, width, height, pixelSize = null) {
  let maxId = 0;
  for (let i = 0; i < labels.length; i++) if (labels[i] > maxId) maxId = labels[i];
  if (maxId === 0) return [];

  const area = new Int32Array(maxId + 1);
  const sumX = new Float64Array(maxId + 1);
  const sumY = new Float64Array(maxId + 1);
  const minX = new Int32Array(maxId + 1).fill(width);
  const maxX = new Int32Array(maxId + 1).fill(-1);
  const minY = new Int32Array(maxId + 1).fill(height);
  const maxY = new Int32Array(maxId + 1).fill(-1);

  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const id = labels[row + x];
      if (id <= 0) continue;
      area[id]++;
      sumX[id] += x;
      sumY[id] += y;
      if (x < minX[id]) minX[id] = x;
      if (x > maxX[id]) maxX[id] = x;
      if (y < minY[id]) minY[id] = y;
      if (y > maxY[id]) maxY[id] = y;
    }
  }

  const umPerPx = pixelSize && Number.isFinite(pixelSize) && pixelSize > 0 ? pixelSize : null;
  const rows = [];
  for (let id = 1; id <= maxId; id++) {
    const px = area[id];
    if (px === 0) continue;
    const eqDiamPx = 2 * Math.sqrt(px / Math.PI);
    rows.push({
      id,
      centroidX: sumX[id] / px,
      centroidY: sumY[id] / px,
      areaPx: px,
      areaUm2: umPerPx ? px * umPerPx * umPerPx : null,
      equivDiameterPx: eqDiamPx,
      equivDiameterUm: umPerPx ? eqDiamPx * umPerPx : null,
      bbox: [minX[id], minY[id], maxX[id] - minX[id] + 1, maxY[id] - minY[id] + 1],
    });
  }
  return rows;
}

/** Extract 1-pixel 4-connected interior boundary outlines from an instance label map for display. */
export function labelOutlines(labels, width, height) {
  const out = new Int32Array(labels.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const id = labels[row + x];
      if (id <= 0) continue;
      if (
        x === 0 || x === width - 1 || y === 0 || y === height - 1
        || labels[row + x - 1] !== id
        || labels[row + x + 1] !== id
        || labels[row - width + x] !== id
        || labels[row + width + x] !== id
      ) {
        out[row + x] = id;
      }
    }
  }
  return out;
}

/** Format per-nucleus CSV table with physical units when pixel size is known. */
export function nucleiCsv(rows) {
  const hasUm = rows.some((r) => r.areaUm2 !== null);
  const header = hasUm
    ? 'id,centroid_x_px,centroid_y_px,area_px,area_um2,equiv_diameter_um,bbox_x,bbox_y,bbox_w,bbox_h'
    : 'id,centroid_x_px,centroid_y_px,area_px,equiv_diameter_px,bbox_x,bbox_y,bbox_w,bbox_h';
  const lines = [header];
  for (const r of rows) {
    const cols = hasUm
      ? [
          r.id,
          r.centroidX.toFixed(3),
          r.centroidY.toFixed(3),
          r.areaPx,
          r.areaUm2.toFixed(3),
          r.equivDiameterUm.toFixed(3),
          ...r.bbox,
        ]
      : [
          r.id,
          r.centroidX.toFixed(3),
          r.centroidY.toFixed(3),
          r.areaPx,
          r.equivDiameterPx.toFixed(3),
          ...r.bbox,
        ];
    lines.push(cols.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Permutation-invariant instance segmentation comparison against an oracle label map:
 * computes foreground Dice, greedy 1-to-1 matched F1 at IoU >= 0.5 and >= 0.75, and mean matched IoU.
 */
export function compareInstanceLabels(pred, ref) {
  const areaP = new Map();
  const areaR = new Map();
  const inter = new Map();
  let fgBoth = 0;
  let fgP = 0;
  let fgR = 0;
  for (let i = 0; i < pred.length; i++) {
    const p = pred[i];
    const r = ref[i];
    if (p > 0) {
      fgP++;
      areaP.set(p, (areaP.get(p) || 0) + 1);
    }
    if (r > 0) {
      fgR++;
      areaR.set(r, (areaR.get(r) || 0) + 1);
    }
    if (p > 0 && r > 0) {
      fgBoth++;
      const key = `${p}:${r}`;
      inter.set(key, (inter.get(key) || 0) + 1);
    }
  }

  const pairs = [];
  for (const [key, cnt] of inter.entries()) {
    const sep = key.indexOf(':');
    const p = Number(key.slice(0, sep));
    const r = Number(key.slice(sep + 1));
    const iou = cnt / (areaP.get(p) + areaR.get(r) - cnt);
    pairs.push({ p, r, iou });
  }
  pairs.sort((a, b) => b.iou - a.iou);

  const usedP = new Set();
  const usedR = new Set();
  const matched = [];
  for (const pair of pairs) {
    if (usedP.has(pair.p) || usedR.has(pair.r)) continue;
    usedP.add(pair.p);
    usedR.add(pair.r);
    matched.push(pair.iou);
  }

  const nP = areaP.size;
  const nR = areaR.size;
  const f1At = (thr) => {
    const tp = matched.filter((v) => v >= thr).length;
    const denom = nP + nR;
    return denom ? (2 * tp) / denom : 1;
  };
  const meanIou = matched.length ? matched.reduce((s, v) => s + v, 0) / matched.length : 1;
  const fgDice = (fgP + fgR) ? (2 * fgBoth) / (fgP + fgR) : 1;

  return {
    predCount: nP,
    refCount: nR,
    matchedCount: matched.length,
    f1At50: Number(f1At(0.5).toFixed(6)),
    f1At75: Number(f1At(0.75).toFixed(6)),
    f1At90: Number(f1At(0.9).toFixed(6)),
    meanMatchedIou: Number(meanIou.toFixed(6)),
    foregroundDice: Number(fgDice.toFixed(6)),
  };
}
