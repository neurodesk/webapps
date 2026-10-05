// Carotid detection and flow curves from one phase-contrast neck slice. Two methods, chosen by
// the data. Unsigned phase frames (a magnitude-weighted speed image, as the requesting lab's
// scanner exports) go through a port of the lab's standalone_automatic_carotid_flow.m.
// Signed velocity goes through detectFromVelocity. The variability method follows the updated
// lab script, retaining the stored voxel grid and affine-based anatomical directions.
// Pure: typed arrays in, typed arrays and numbers out, so Node tests it without a browser.
import { connectedComponents3D, keepLargestComponent } from '@neurodesk/webapp-components/volume';

export const DEFAULTS = Object.freeze({
  headPercentile: 20,
  candidatePercentile: 99.9,
  // Search band as fractions of the head's extent, from the head centre.
  posterior: 0.15,
  anterior: 0.10,
  lateral: 0.30,
  midline: 0.08,
  minSeparation: 5,
  tiltLimit: 30,
  // Velocity method: vessels are pixels whose mean speed exceeds this fraction of the 99.9th
  // percentile inside the head, and blobs smaller than minPixels are dropped.
  velocityFraction: 0.25,
  minPixels: 4,
});

// Raw 12-bit phase, as Siemens stores it, spans ±4096 (or 0–4095); velocities in cm/s stay
// well inside ±1000 for any VENC used on the neck.
const RAW_PHASE = 1000;

// MATLAB strel('disk', 3): a 7 × 7 octagon, not the Euclidean disk.
const DISK3 = ['0011100', '0111110', '1111111', '1111111', '1111111', '0111110', '0011100'];

/** MATLAB prctile: sorted value k sits at percentile 100 (k - 0.5) / n, linear between, clamped. */
export function percentile(values, p) {
  const sorted = Float64Array.from(values).sort();
  const n = sorted.length;
  if (!n) return NaN;
  const rank = (p / 100) * n + 0.5;
  if (rank <= 1) return sorted[0];
  if (rank >= n) return sorted[n - 1];
  const low = Math.floor(rank);
  return sorted[low - 1] + (rank - low) * (sorted[low] - sorted[low - 1]);
}

/**
 * The first half of the frames is amplitude, the second half phase, as the scanner exports a
 * retrospectively gated PC series. frames × voxels values, frame-major.
 */
export function splitSeries(data, voxels, frames) {
  if (frames < 4 || frames % 2) {
    throw new Error(`Expected amplitude frames followed by the same number of phase frames; this series has ${frames} frame${frames === 1 ? '' : 's'}.`);
  }
  const phases = frames / 2;
  return {
    phases,
    amplitude: data.subarray(0, phases * voxels),
    phase: data.subarray(phases * voxels, frames * voxels),
  };
}

/**
 * Which in-plane voxel axis runs left–right and which anterior–posterior, and the direction of
 * each. `leftward` is +1 when increasing the index moves toward the patient's left (world x
 * falls, RAS), `anterior` is +1 when it moves forward.
 */
export function inPlaneAxes(affine) {
  const lr = Math.abs(affine[0][0]) >= Math.abs(affine[0][1]) ? 0 : 1;
  const ap = 1 - lr;
  return { lr, ap, leftward: affine[0][lr] < 0 ? 1 : -1, anterior: affine[1][ap] > 0 ? 1 : -1 };
}

/** Voxel-wise mean over frames, frame-major input. */
export function meanFrames(data, voxels, frames) {
  const out = new Float64Array(voxels);
  for (let t = 0; t < frames; t++) for (let v = 0; v < voxels; v++) out[v] += data[t * voxels + v];
  for (let v = 0; v < voxels; v++) out[v] /= frames;
  return out;
}

/** Sample standard deviation over frames (MATLAB std(x, 0, 3)). */
function temporalStd(data, voxels, frames) {
  const average = meanFrames(data, voxels, frames);
  const out = new Float64Array(voxels);
  for (let t = 0; t < frames; t++) {
    for (let v = 0; v < voxels; v++) out[v] += (data[t * voxels + v] - average[v]) ** 2;
  }
  for (let v = 0; v < voxels; v++) out[v] = Math.sqrt(out[v] / (frames - 1));
  return out;
}

/** Binary erosion by DISK3, with the image border treated as foreground like imerode. */
function erodeDisk3(mask, nx, ny) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < ny; y++) {
    for (let x = 0; x < nx; x++) {
      if (!mask[y * nx + x]) continue;
      let keep = 1;
      for (let dy = -3; dy <= 3 && keep; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          if (DISK3[dy + 3][dx + 3] !== '1') continue;
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
          if (!mask[yy * nx + xx]) { keep = 0; break; }
        }
      }
      out[y * nx + x] = keep;
    }
  }
  return out;
}

/** The largest bright region of the mean amplitude above its percentile, eroded. */
function headMask(meanAmplitude, nx, ny, level) {
  const threshold = percentile(meanAmplitude, level);
  const bright = meanAmplitude.map(value => (value > threshold ? 1 : 0));
  const head = erodeDisk3(keepLargestComponent(bright, [nx, ny, 1]), nx, ny);
  const inHead = [];
  for (let v = 0; v < head.length; v++) if (head[v]) inHead.push(v);
  if (!inHead.length) throw new Error('No head found in the amplitude frames. Check which series is amplitude.');
  return { head, inHead };
}

/** Signed phase has a real negative lobe; the unsigned speed image the port expects has none. */
export function isSignedPhase(phase) {
  let low = Infinity;
  let high = -Infinity;
  for (const value of phase) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return low < -0.05 * Math.max(high, 1e-9);
}

/**
 * cm/s per stored unit. Velocity-scaled phase (Philips and GE through dcm2niix) is already cm/s;
 * raw ±4096 phase needs the VENC, which maps ±4096 to ±VENC.
 */
export function velocityScale(phase, venc) {
  let largest = 0;
  for (const value of phase) largest = Math.max(largest, Math.abs(value));
  if (largest <= RAW_PHASE) return 1;
  if (!(venc > 0)) throw new Error('This phase series is stored as raw phase (±4096). Enter the velocity encoding (VENC) under Advanced settings.');
  return venc / 4096;
}

/**
 * Find both carotids and their curves: the velocity method for signed phase, the port of the
 * lab's script for an unsigned speed image.
 * @param {{ amplitude: ArrayLike<number>, phase: ArrayLike<number>, nx: number, ny: number,
 *           phases: number, affine: number[][], voxelSize?: number[] }} series
 */
export function detectCarotids(series, options = {}) {
  return isSignedPhase(series.phase) ? detectFromVelocity(series, options) : detectFromVariability(series, options);
}

function extentOf(values) {
  let low = Infinity;
  let high = -Infinity;
  for (const value of values) {
    low = Math.min(low, value);
    high = Math.max(high, value);
  }
  return high - low;
}

/** Bilinear symmetry search in an affine-oriented plane, without resampling the input masks. */
function estimateTilt(amplitude, head, nx, ny, axes, cx, cy, limit) {
  const width = axes.lr === 0 ? nx : ny;
  const height = axes.ap === 0 ? nx : ny;
  const sample = (x, y) => {
    const i = axes.lr === 0 ? x : y;
    const j = axes.lr === 0 ? y : x;
    const ix = Math.floor(i);
    const iy = Math.floor(j);
    let value = 0;
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const xx = ix + dx;
        const yy = iy + dy;
        if (xx < 0 || yy < 0 || xx >= nx || yy >= ny) continue;
        const v = yy * nx + xx;
        if (head[v]) value += amplitude[v] * (dx ? i - ix : 1 - i + ix) * (dy ? j - iy : 1 - j + iy);
      }
    }
    return value;
  };
  const scores = [];
  let best = { score: -Infinity, degrees: 0 };
  const rotated = new Float64Array(width * height);
  for (let degrees = -limit; degrees <= limit; degrees += 0.5) {
    const c = Math.cos(degrees * Math.PI / 180);
    const s = Math.sin(degrees * Math.PI / 180);
    let sum = 0;
    let squares = 0;
    let product = 0;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const u = x - (width - 1) / 2;
        const w = y - (height - 1) / 2;
        const value = sample(cx + c * u + s * w, cy + axes.anterior * (-s * u + c * w));
        rotated[y * width + x] = value;
        sum += value;
        squares += value * value;
      }
    }
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) product += rotated[y * width + x] * rotated[y * width + width - 1 - x];
    }
    const centred = sum * sum / rotated.length;
    const score = squares > centred ? (product - centred) / (squares - centred) : 0;
    scores.push(score);
    if (score > best.score) best = { score, degrees };
  }
  return { degrees: best.degrees, contrast: best.score - percentile(scores, 50), atEdge: Math.abs(best.degrees) === limit };
}

/** The port of standalone_automatic_carotid_flow.m. Curves are phase-image intensities. */
export function detectFromVariability(series, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  for (const [key, low, high, step] of [
    ['tiltLimit', 0.5, 60, 0.5],
    ['posterior', 0, 0.5, 0.01],
    ['anterior', 0, 0.5, 0.01],
    ['lateral', 0.01, 0.5, 0.01],
    ['midline', 0, 0.49, 0.01],
    ['minSeparation', 1, 100, 1],
  ]) {
    const value = settings[key];
    if (!Number.isFinite(value) || value < low || value > high || Math.abs(value / step - Math.round(value / step)) > 1e-8) {
      throw new Error(`${key} must be ${low} to ${high}, in steps of ${step}.`);
    }
  }
  if (settings.midline >= settings.lateral) throw new Error('Midline exclusion must be smaller than the lateral extent.');
  const { amplitude, phase, nx, ny, phases, affine } = series;
  const voxels = nx * ny;
  const axes = inPlaneAxes(affine);
  const coordinate = (v, axis) => (axis === 0 ? v % nx : Math.floor(v / nx));
  const extent = [nx, ny];

  // 1. Head: the largest bright region of the mean amplitude, eroded.
  const meanAmplitude = meanFrames(amplitude, voxels, phases);
  const { head, inHead } = headMask(meanAmplitude, nx, ny, settings.headPercentile);
  const span = (axis) => {
    let low = Infinity;
    let high = -Infinity;
    let sum = 0;
    for (const v of inHead) {
      const c = coordinate(v, axis) + 1;
      sum += c;
      if (c < low) low = c;
      if (c > high) high = c;
    }
    return { centre: sum / inHead.length, size: high - low };
  };
  const across = span(axes.lr);
  const along = span(axes.ap);

  // 2. Temporal variability of the phase, inside the head only.
  const variability = temporalStd(phase, voxels, phases);
  for (let v = 0; v < voxels; v++) if (!head[v]) variability[v] = 0;
  const threshold = percentile(inHead.map(v => variability[v]), settings.candidatePercentile);

  // 3. Anatomical band: just behind to just in front of the head centre, lateral to the midline.
  const tilt = estimateTilt(meanAmplitude, head, nx, ny, axes, across.centre - 1, along.centre - 1, settings.tiltLimit);
  const c = Math.cos(tilt.degrees * Math.PI / 180);
  const s = Math.sin(tilt.degrees * Math.PI / 180);
  const aligned = (u, w) => {
    const x = u - across.centre;
    const y = axes.anterior * (w - along.centre);
    return [c * x - s * y, s * x + c * y];
  };
  const positions = inHead.map(v => aligned(coordinate(v, axes.lr) + 1, coordinate(v, axes.ap) + 1));
  const width = extentOf(positions.map(p => p[0]));
  const height = extentOf(positions.map(p => p[1]));
  const candidates = new Uint8Array(voxels);
  for (let v = 0; v < voxels; v++) {
    if (!(variability[v] > threshold)) continue;
    const [u, w] = aligned(coordinate(v, axes.lr) + 1, coordinate(v, axes.ap) + 1);
    if (w < -settings.posterior * height || w > settings.anterior * height) continue;
    if (Math.abs(u) > settings.lateral * width || Math.abs(u) < settings.midline * width) continue;
    candidates[v] = 1;
  }

  // 4. Blobs, in the order MATLAB's column-major scan of the transposed image finds them.
  const { labels, numComponents } = connectedComponents3D(candidates, [nx, ny, 1]);
  const blobs = Array.from({ length: numComponents }, () => ({ pixels: [], u: 0, w: 0, first: Infinity }));
  for (let v = 0; v < voxels; v++) {
    if (!labels[v]) continue;
    const blob = blobs[labels[v] - 1];
    const u = coordinate(v, axes.lr) + 1;
    const w = coordinate(v, axes.ap) + 1;
    blob.pixels.push(v);
    blob.u += u;
    blob.w += w;
    blob.first = Math.min(blob.first, u * extent[axes.ap] + w);
  }
  for (const blob of blobs) {
    blob.u /= blob.pixels.length;
    blob.w /= blob.pixels.length;
  }
  blobs.sort((a, b) => a.first - b.first);
  if (blobs.length < 2) {
    throw new Error(`Found ${blobs.length} candidate vessel${blobs.length === 1 ? '' : 's'} in the search band, need two. Lower the candidate percentile or check the slice position.`);
  }

  const staticThreshold = percentile(inHead.map(v => variability[v]), 50);
  const phaseMean = meanFrames(phase, voxels, phases);
  const baseline = percentile(inHead.filter(v => variability[v] <= staticThreshold).map(v => phaseMean[v]), 50);
  for (const blob of blobs) {
    blob.aligned = aligned(blob.u, blob.w);
    blob.curve = Float64Array.from({ length: phases }, (_, t) =>
      blob.pixels.reduce((sum, v) => sum + phase[t * voxels + v], 0) / blob.pixels.length);
    blob.net = blob.curve.reduce((sum, value) => sum + value, 0) / phases - baseline;
    blob.pulse = Math.max(...blob.curve) - Math.min(...blob.curve);
  }
  const strongest = blobs.reduce((best, blob) => blob.pulse > best.pulse ? blob : best);
  const arterialSign = Math.sign(strongest.net);
  const valid = blobs.filter(blob => Math.sign(blob.net) === arterialSign);
  if (!arterialSign || valid.length < 2) throw new Error('Fewer than two arterial-polarity blobs. Check the search band and candidate percentile.');

  // Pair geometry is measured in the head-aligned frame; masks stay in the original grid.
  let best = null;
  for (let i = 0; i < valid.length; i++) {
    for (let j = i + 1; j < valid.length; j++) {
      const level = Math.abs(valid[i].aligned[1] - valid[j].aligned[1]);
      const apart = Math.abs(valid[i].aligned[0] - valid[j].aligned[0]);
      if (apart < level || apart < settings.minSeparation) continue;
      const score = apart / (1 + level ** 2);
      if (!best || score > best.score) best = { score, pair: [valid[i], valid[j]] };
    }
  }
  if (!best) throw new Error('No side-by-side pair of vessels found; the candidates are stacked front to back.');

  // 6. Patient left has the smaller world x (RAS).
  const worldX = (blob) => {
    const ij = [0, 0];
    ij[axes.lr] = blob.u - 1;
    ij[axes.ap] = blob.w - 1;
    return affine[0][0] * ij[0] + affine[0][1] * ij[1] + affine[0][3];
  };
  const [left, right] = best.pair.slice().sort((a, b) => worldX(a) - worldX(b));
  const pixelArea = Math.abs((series.voxelSize?.[0] ?? 1) * (series.voxelSize?.[1] ?? 1));
  const vessel = (blob, side) => {
    const curve = blob.curve.map(value => arterialSign * (value - baseline));
    return { side, pixels: blob.pixels, centroid: [blob.u, blob.w], areaMm2: blob.pixels.length * pixelArea, curve, ...curveMetrics(curve) };
  };

  const leftVessel = vessel(left, 'left');
  const rightVessel = vessel(right, 'right');
  const separation = Math.abs(left.aligned[0] - right.aligned[0]);
  const qc = {
    tiltDegrees: tilt.degrees,
    symmetryContrast: tilt.contrast,
    tiltAtEdge: tilt.atEdge,
    pairOffcentre: Math.abs(left.aligned[0] + right.aligned[0]) / separation,
    pairVshift: Math.abs(left.aligned[1] - right.aligned[1]) / separation,
    peakLag: ((leftVessel.peakFrame - rightVessel.peakFrame + Math.floor(phases / 2) + phases) % phases) - Math.floor(phases / 2),
  };
  qc.flag = qc.tiltAtEdge || Math.abs(qc.peakLag) > 1 || qc.pairOffcentre > 0.3 || qc.pairVshift > 0.3;
  const mask = new Uint8Array(voxels);
  for (const v of left.pixels) mask[v] = 1;
  for (const v of right.pixels) mask[v] = 2;
  return {
    left: leftVessel,
    right: rightVessel,
    mask,
    head,
    candidates,
    meanAmplitude: Float32Array.from(meanAmplitude),
    variability: Float32Array.from(variability),
    threshold,
    qc,
    baseline,
    arterialSign,
    axes,
    blobs: blobs.length,
    method: 'variability',
  };
}

/**
 * Signed velocity. Vessels are blobs of fast mean flow in either direction. Arteries are the
 * direction whose flow pulses more (Gosling's index, flow-weighted over its blobs; veins in the
 * neck pulse far less), and each carotid is the artery carrying most flow on its side of the
 * head centre. Curves are mean velocity (cm/s) and flow (ml/min) through a fixed ROI.
 */
export function detectFromVelocity(series, options = {}) {
  const settings = { ...DEFAULTS, ...options };
  const { amplitude, nx, ny, phases, affine } = series;
  const voxels = nx * ny;
  const scale = velocityScale(series.phase, settings.venc);
  const velocity = scale === 1 ? series.phase : series.phase.map(value => value * scale);
  const meanAmplitude = meanFrames(amplitude, voxels, phases);
  const { head, inHead } = headMask(meanAmplitude, nx, ny, settings.headPercentile);
  const meanVelocity = meanFrames(velocity, voxels, phases);
  const threshold = settings.velocityFraction * percentile(inHead.map(v => Math.abs(meanVelocity[v])), 99.9);
  const pixelArea = Math.abs((series.voxelSize?.[0] ?? 1) * (series.voxelSize?.[1] ?? 1));
  const worldX = (i, j) => affine[0][0] * i + affine[0][1] * j + affine[0][3];

  const blobs = [];
  for (const sign of [1, -1]) {
    const fast = new Uint8Array(voxels);
    for (const v of inHead) if (sign * meanVelocity[v] > threshold) fast[v] = 1;
    const { labels, numComponents } = connectedComponents3D(fast, [nx, ny, 1]);
    const members = Array.from({ length: numComponents }, () => []);
    for (let v = 0; v < voxels; v++) if (labels[v]) members[labels[v] - 1].push(v);
    for (const pixels of members) {
      if (pixels.length < settings.minPixels) continue;
      const speed = new Float64Array(phases);
      for (let t = 0; t < phases; t++) {
        let sum = 0;
        for (const v of pixels) sum += velocity[t * voxels + v];
        speed[t] = (sign * sum) / pixels.length;
      }
      const areaMm2 = pixels.length * pixelArea;
      // cm/s through mm²: 0.01 ml/s, so 0.6 ml/min.
      const flow = speed.map(value => value * areaMm2 * 0.6);
      let i = 0;
      let j = 0;
      for (const v of pixels) { i += v % nx; j += Math.floor(v / nx); }
      i /= pixels.length;
      j /= pixels.length;
      blobs.push({ sign, pixels, speed, flow, areaMm2, centroid: [i + 1, j + 1], x: worldX(i, j), ...curveMetrics(flow) });
    }
  }
  const pulsatility = (sign) => {
    let weighted = 0;
    let total = 0;
    for (const blob of blobs) {
      if (blob.sign !== sign || !(blob.mean > 0)) continue;
      weighted += blob.pulsatility * blob.mean;
      total += blob.mean;
    }
    return total ? weighted / total : -Infinity;
  };
  const arterial = pulsatility(1) >= pulsatility(-1) ? 1 : -1;
  let ci = 0;
  let cj = 0;
  for (const v of inHead) { ci += v % nx; cj += Math.floor(v / nx); }
  const midline = worldX(ci / inHead.length, cj / inHead.length);
  const largest = (onSide) => blobs
    .filter(blob => blob.sign === arterial && onSide(blob.x))
    .sort((a, b) => b.mean - a.mean)[0];
  // RAS: the patient's left has the smaller world x.
  const left = largest(x => x < midline);
  const right = largest(x => x >= midline);
  if (!left || !right) {
    throw new Error(`Found arterial flow on ${left || right ? 'one side' : 'neither side'} of the neck, need both. Check the slice position and the velocity encoding.`);
  }
  const vessel = (blob, side) => ({
    side,
    pixels: blob.pixels,
    centroid: blob.centroid,
    areaMm2: blob.areaMm2,
    curve: blob.flow,
    velocity: blob.speed,
    ...curveMetrics(blob.flow),
  });
  const mask = new Uint8Array(voxels);
  for (const v of left.pixels) mask[v] = 1;
  for (const v of right.pixels) mask[v] = 2;
  const variability = temporalStd(velocity, voxels, phases);
  for (let v = 0; v < voxels; v++) if (!head[v]) variability[v] = 0;
  return {
    left: vessel(left, 'left'),
    right: vessel(right, 'right'),
    mask,
    head,
    meanAmplitude: Float32Array.from(meanAmplitude),
    variability: Float32Array.from(variability),
    threshold,
    arterialSign: arterial,
    blobs: blobs.length,
    method: 'velocity',
  };
}

/** Peak, trough, time average and Gosling's pulsatility index, (max − min) / mean. */
export function curveMetrics(curve) {
  let peak = -Infinity;
  let trough = Infinity;
  let sum = 0;
  let peakFrame = 0;
  curve.forEach((value, t) => {
    sum += value;
    if (value > peak) { peak = value; peakFrame = t; }
    if (value < trough) trough = value;
  });
  const average = sum / curve.length;
  return { peak, trough, mean: average, peakFrame, pulsatility: average ? (peak - trough) / average : NaN };
}

/** One row per frame: phase intensity per carotid, or velocity and flow per carotid. */
export function curvesCsv(result) {
  const { left, right } = result;
  const velocity = result.method === 'velocity';
  const rows = [velocity
    ? 'frame,left_velocity_cm_s,left_flow_ml_min,right_velocity_cm_s,right_flow_ml_min'
    : 'frame,left_carotid,right_carotid'];
  for (let t = 0; t < left.curve.length; t++) {
    const cells = velocity
      ? [left.velocity[t], left.curve[t], right.velocity[t], right.curve[t]]
      : [left.curve[t], right.curve[t]];
    rows.push([t + 1, ...cells.map(value => value.toFixed(4))].join(','));
  }
  return `${rows.join('\n')}\n`;
}
