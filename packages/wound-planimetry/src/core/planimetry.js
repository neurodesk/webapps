// Pure DOM-free calibrated wound planimetry: ruler calibration, area-preserving
// crack-code boundary polygon perimeter (consistent with exact pixel-cell area
// across arbitrary components, holes and diagonals so circularity <= 1 always),
// principal-axis major length x perpendicular width with oblique pixel extent,
// Kundin ellipsoid area, circularity and compactness.

const CRACK_DX = [1, 0, -1, 0];
const CRACK_DY = [0, 1, 0, -1];
const STAIRCASE_SAVING = 2 - Math.SQRT2;

/**
 * Compute spatial calibration (px/mm) from two points across a known ruler length.
 * @param {[number, number]} p1
 * @param {[number, number]} p2
 * @param {number} referenceMm
 */
export function calibrationFromRuler(p1, p2, referenceMm) {
  if (!Number.isFinite(referenceMm) || referenceMm <= 0) {
    throw new Error("Reference ruler length must be greater than 0 mm.");
  }
  const pixelDist = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  if (!Number.isFinite(pixelDist) || pixelDist < 1) {
    throw new Error("Drag or click two distinct points along the ruler.");
  }
  return {
    pixelDist,
    referenceMm,
    pixelsPerMm: pixelDist / referenceMm,
  };
}

/**
 * Compute 4-connected foreground boundary mask (1 = wound boundary pixel).
 */
export function extractBoundaryMask(mask, width, height) {
  const boundary = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const idx = row + x;
      if (!mask[idx]) continue;
      if (
        x === 0 || y === 0 || x === width - 1 || y === height - 1 ||
        !mask[idx - 1] || !mask[idx + 1] || !mask[idx - width] || !mask[idx + width]
      ) {
        boundary[idx] = 1;
      }
    }
  }
  return boundary;
}

/**
 * Trace all outer and hole crack-code boundary loops enclosing the foreground
 * unit pixel cells [x, x+1] x [y, y+1], then replace disjoint alternating
 * convex/concave unit staircase corners with diagonal chords of length sqrt(2).
 * Each chord removes a 1/8-area convex corner triangle and adds an equal
 * 1/8-area concave corner triangle inside disjoint pixel-cell corners, so the
 * polygonal region has area identically equal to areaPx and strictly satisfies
 * the Euclidean isoperimetric inequality (circularity = 4*pi*A / P^2 <= 1).
 */
export function traceContourPerimeter(mask, width, height) {
  const stride = width + 1;
  const edges = new Uint8Array(stride * (height + 1));
  let edgeCount = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    const vRow = y * stride;
    const vNext = vRow + stride;
    for (let x = 0; x < width; x++) {
      if (!mask[row + x]) continue;
      if (y === 0 || !mask[row - width + x]) {
        edges[vRow + x] |= 1; // dir 0: +x
        edgeCount++;
      }
      if (x === width - 1 || !mask[row + x + 1]) {
        edges[vRow + x + 1] |= 2; // dir 1: +y
        edgeCount++;
      }
      if (y === height - 1 || !mask[row + width + x]) {
        edges[vNext + x + 1] |= 4; // dir 2: -x
        edgeCount++;
      }
      if (x === 0 || !mask[row + x - 1]) {
        edges[vNext + x] |= 8; // dir 3: -y
        edgeCount++;
      }
    }
  }

  if (edgeCount === 0) {
    return { perimeterPx: 0, crackPerimeterPx: 0, contourCount: 0, loopCount: 0 };
  }

  let perimeterPx = 0;
  let loopCount = 0;

  for (let startKey = 0; startKey < edges.length; startKey++) {
    while (edges[startKey] !== 0) {
      let startDir = 0;
      while ((edges[startKey] & (1 << startDir)) === 0) startDir++;
      edges[startKey] &= ~(1 << startDir);

      const dirs = [];
      let key = startKey;
      let dir = startDir;

      for (;;) {
        dirs.push(dir);
        const vx = (key % stride) + CRACK_DX[dir];
        const vy = ((key - (key % stride)) / stride) + CRACK_DY[dir];
        key = vy * stride + vx;

        const rightDir = (dir + 1) & 3;
        if (key === startKey && (edges[key] === 0 || rightDir === startDir)) {
          break;
        }

        const avail = edges[key];
        let nextDir = -1;
        if (avail & (1 << rightDir)) nextDir = rightDir;
        else if (avail & (1 << dir)) nextDir = dir;
        else if (avail & (1 << ((dir + 3) & 3))) nextDir = (dir + 3) & 3;
        else break;

        edges[key] &= ~(1 << nextDir);
        dir = nextDir;
      }

      const m = dirs.length;
      loopCount++;
      const turns = new Int8Array(m);
      for (let i = 0; i < m; i++) {
        const prev = dirs[(i + m - 1) % m];
        const diff = (dirs[i] - prev + 4) & 3;
        turns[i] = diff === 1 ? 1 : diff === 3 ? -1 : 0;
      }

      // Start scanning at a non-alternating turn boundary for rotation-invariant optimal pairing.
      let breakIdx = 0;
      for (let i = 0; i < m; i++) {
        const prevTurn = turns[(i + m - 1) % m];
        if (turns[i] === 0 || turns[i] === prevTurn) {
          breakIdx = i;
          break;
        }
      }

      const used = new Uint8Array(m);
      let pairs = 0;
      for (let k = 0; k < m; k++) {
        const idx = (breakIdx + k) % m;
        const next = (idx + 1) % m;
        if (!used[idx] && !used[next] && turns[idx] !== 0 && turns[idx] === -turns[next]) {
          used[idx] = 1;
          used[next] = 1;
          pairs++;
        }
      }

      perimeterPx += m - pairs * STAIRCASE_SAVING;
    }
  }

  return { perimeterPx, crackPerimeterPx: edgeCount, contourCount: edgeCount, loopCount };
}

/**
 * Measure digital planimetry metrics of a binary wound mask.
 * @param {Uint8Array} mask Binary mask (0/1) of length width * height.
 * @param {number} width
 * @param {number} height
 * @param {number} [pixelsPerMm=0] When > 0, physical mm/mm²/cm² metrics are populated.
 * @param {Uint8Array | null} [opaque=null] Optional opacity mask (1 = opaque, 0 = transparent).
 */
export function measurePlanimetry(mask, width, height, pixelsPerMm = 0, opaque = null) {
  const calibrated = Number.isFinite(pixelsPerMm) && pixelsPerMm > 0;
  let effectiveMask = mask;
  if (opaque) {
    effectiveMask = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] && opaque[i]) effectiveMask[i] = 1;
    }
  }
  const boundary = extractBoundaryMask(effectiveMask, width, height);

  let areaPx = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      if (effectiveMask[row + x]) {
        areaPx++;
        sumX += x;
        sumY += y;
      }
    }
  }

  if (areaPx === 0) {
    return {
      calibrated,
      pixelsPerMm: calibrated ? pixelsPerMm : 0,
      areaPx: 0,
      areaMm2: calibrated ? 0 : null,
      areaCm2: calibrated ? 0 : null,
      perimeterPx: 0,
      perimeterMm: calibrated ? 0 : null,
      lengthPx: 0,
      widthPx: 0,
      lengthMm: calibrated ? 0 : null,
      widthMm: calibrated ? 0 : null,
      kundinAreaPx: 0,
      kundinAreaMm2: calibrated ? 0 : null,
      kundinAreaCm2: calibrated ? 0 : null,
      circularity: 0,
      compactness: 0,
      orientationDeg: 0,
      centroid: null,
      axes: null,
      boundary,
    };
  }

  const cx = sumX / areaPx;
  const cy = sumY / areaPx;

  // Second central moments for principal axes.
  let mu20 = 0;
  let mu02 = 0;
  let mu11 = 0;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      if (!effectiveMask[row + x]) continue;
      const dx = x - cx;
      mu20 += dx * dx;
      mu02 += dy * dy;
      mu11 += dx * dy;
    }
  }
  mu20 /= areaPx;
  mu02 /= areaPx;
  mu11 /= areaPx;

  let angleRad = 0.5 * Math.atan2(2 * mu11, mu20 - mu02);
  let ux = Math.cos(angleRad);
  let uy = Math.sin(angleRad);
  let vx = -uy;
  let vy = ux;

  // Project boundary pixel centres onto principal axes for oriented bounding box.
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const dy = y - cy;
    for (let x = 0; x < width; x++) {
      if (!boundary[row + x]) continue;
      const dx = x - cx;
      const u = dx * ux + dy * uy;
      const v = dx * vx + dy * vy;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
  }

  // Exact oblique projection extent of a unit pixel square onto (ux, uy) and (vx, vy).
  const pixelExtent = Math.abs(ux) + Math.abs(uy);
  const halfExtent = 0.5 * pixelExtent;

  let lengthPx = maxU - minU + pixelExtent;
  let widthPx = maxV - minV + pixelExtent;
  if (widthPx > lengthPx) {
    // Rotating by +pi/2 maps u' = v and v' = -u, so [minV', maxV'] = [-maxU, -minU].
    [lengthPx, widthPx] = [widthPx, lengthPx];
    [minU, maxU, minV, maxV] = [minV, maxV, -maxU, -minU];
    angleRad += Math.PI / 2;
    ux = Math.cos(angleRad);
    uy = Math.sin(angleRad);
    vx = -uy;
    vy = ux;
  }

  const { perimeterPx } = traceContourPerimeter(effectiveMask, width, height);
  const kundinAreaPx = (Math.PI / 4) * lengthPx * widthPx;
  const circularity = perimeterPx > 0 ? Math.min(1, (4 * Math.PI * areaPx) / (perimeterPx * perimeterPx)) : 0;
  const compactness = circularity > 0 ? 1 / circularity : 0;

  const uMin = minU - halfExtent;
  const uMax = maxU + halfExtent;
  const vMin = minV - halfExtent;
  const vMax = maxV + halfExtent;
  const midU = 0.5 * (uMin + uMax);
  const midV = 0.5 * (vMin + vMax);
  const cxDraw = cx + 0.5;
  const cyDraw = cy + 0.5;

  const axes = {
    major: [
      [cxDraw + uMin * ux + midV * vx, cyDraw + uMin * uy + midV * vy],
      [cxDraw + uMax * ux + midV * vx, cyDraw + uMax * uy + midV * vy],
    ],
    minor: [
      [cxDraw + midU * ux + vMin * vx, cyDraw + midU * uy + vMin * vy],
      [cxDraw + midU * ux + vMax * vx, cyDraw + midU * uy + vMax * vy],
    ],
  };

  let orientationDeg = (angleRad * 180) / Math.PI;
  if (orientationDeg <= -90) orientationDeg += 180;
  if (orientationDeg > 90) orientationDeg -= 180;

  const mmPerPx = calibrated ? 1 / pixelsPerMm : null;
  const mm2PerPx = calibrated ? mmPerPx * mmPerPx : null;
  const areaMm2 = calibrated ? areaPx * mm2PerPx : null;
  const kundinAreaMm2 = calibrated ? kundinAreaPx * mm2PerPx : null;

  return {
    calibrated,
    pixelsPerMm: calibrated ? pixelsPerMm : 0,
    areaPx,
    areaMm2,
    areaCm2: calibrated ? areaMm2 / 100 : null,
    perimeterPx,
    perimeterMm: calibrated ? perimeterPx * mmPerPx : null,
    lengthPx,
    widthPx,
    lengthMm: calibrated ? lengthPx * mmPerPx : null,
    widthMm: calibrated ? widthPx * mmPerPx : null,
    kundinAreaPx,
    kundinAreaMm2,
    kundinAreaCm2: calibrated ? kundinAreaMm2 / 100 : null,
    circularity,
    compactness,
    orientationDeg,
    centroid: [cx, cy],
    axes,
    boundary,
  };
}
