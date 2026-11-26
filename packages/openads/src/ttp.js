// Pure 4D PWI -> Time-To-Peak (TTP) perfusion map calculation (OpenADS TTP pipeline).

export const TTP_DEFAULTS = {
  echoTime: 0.03,
  fwhmSpatial: 2.35,
  fwhmTemporal: 3.53,
  baselineVolumesMin: 6,
  baselinePercentage: 0.1,
  skipVolumes: 1,
  trimLow: 1,
  trimHigh: 1,
  peak: { prominence: 1, height: 2, width: 3 },
  numPeaks: 3,
  neighborhood: [3, 3, 1],
  zThresholds: [3, 3],
  quantileThresholds: [0.99, 5e-4],
};

function linearInterpExtrap(xKnown, yKnown, xq) {
  const n = xKnown.length;
  if (n === 1) return yKnown[0];
  if (xq <= xKnown[0]) {
    const t = (xq - xKnown[0]) / (xKnown[1] - xKnown[0]);
    return yKnown[0] + t * (yKnown[1] - yKnown[0]);
  }
  if (xq >= xKnown[n - 1]) {
    const t = (xq - xKnown[n - 2]) / (xKnown[n - 1] - xKnown[n - 2]);
    return yKnown[n - 2] + t * (yKnown[n - 1] - yKnown[n - 2]);
  }
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xKnown[mid] <= xq) lo = mid;
    else hi = mid;
  }
  const t = (xq - xKnown[lo]) / (xKnown[hi] - xKnown[lo]);
  return yKnown[lo] + t * (yKnown[hi] - yKnown[lo]);
}

export function defaultSliceTiming(nz, tr, code = 3) {
  const step = tr / nz;
  const order = [];
  if (code === 1) {
    for (let i = 0; i < nz; i++) order.push(i);
  } else if (code === 2) {
    for (let i = 0; i < nz; i += 2) order.push(i);
    for (let i = 1; i < nz; i += 2) order.push(i);
  } else {
    for (let i = 1; i < nz; i += 2) order.push(i);
    for (let i = 0; i < nz; i += 2) order.push(i);
  }
  const timing = new Array(nz);
  for (let k = 0; k < nz; k++) {
    timing[order[k]] = k * step;
  }
  return timing;
}

export function sliceTimeCorrection(pwi, dims, tr, sliceTiming, epsilon = 1e-6) {
  const [nx, ny, nz, nt] = dims;
  if (!Number.isFinite(tr) || tr <= 0) {
    throw new Error(`Invalid PWI repetition time (${tr}).`);
  }
  if (!Number.isInteger(nt) || nt < 2) {
    throw new Error(`Slice-time correction requires a 4D PWI series (received ${nt} frame${nt === 1 ? '' : 's'}).`);
  }
  let timing;
  if (sliceTiming != null) {
    if (!Array.isArray(sliceTiming) || sliceTiming.length !== nz) {
      throw new Error(`SliceTiming length (${sliceTiming?.length}) does not match PWI slice count (${nz}).`);
    }
    if (!sliceTiming.every((v) => Number.isFinite(v) && v >= 0)) {
      throw new Error('SliceTiming contains non-finite or negative entries.');
    }
    timing = sliceTiming;
  } else {
    timing = defaultSliceTiming(nz, tr, 3);
  }
  const minTiming = Math.min(...timing);
  const timeRef = new Float64Array(nt);
  for (let t = 0; t < nt; t++) timeRef[t] = minTiming + tr * t;
  const out = new Float32Array(pwi.length);
  const sliceStride = nx * ny;
  const volStride = nx * ny * nz;
  const yKnown = new Float64Array(nt);
  for (let z = 0; z < nz; z++) {
    const timeSlice = new Float64Array(nt);
    for (let t = 0; t < nt; t++) timeSlice[t] = minTiming + timing[z] + tr * t;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const base = x + y * nx + z * sliceStride;
        for (let t = 0; t < nt; t++) yKnown[t] = pwi[base + t * volStride];
        for (let t = 0; t < nt; t++) {
          let v = linearInterpExtrap(timeSlice, yKnown, timeRef[t]);
          if (v <= 0) v = epsilon;
          out[base + t * volStride] = v;
        }
      }
    }
  }
  return { data: out, timeRef };
}

function gaussianKernel1D(sigma, truncate = 4) {
  if (sigma <= 0) return new Float64Array([1]);
  const radius = Math.max(1, Math.round(truncate * sigma));
  const kernel = new Float64Array(2 * radius + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const v = Math.exp(-0.5 * (i / sigma) ** 2);
    kernel[i + radius] = v;
    sum += v;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum;
  return kernel;
}

function reflectIndex(i, n) {
  if (n === 1) return 0;
  const period = 2 * n;
  const k = ((i % period) + period) % period;
  return k >= n ? period - 1 - k : k;
}

function convolve1DAxis(src, out, base, axisLen, axisStride, kernel) {
  const radius = (kernel.length - 1) / 2;
  for (let i = 0; i < axisLen; i++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = reflectIndex(i + k, axisLen);
      acc += src[base + j * axisStride] * kernel[k + radius];
    }
    out[base + i * axisStride] = acc;
  }
}

function gaussianFilter4D(data, dims, sigma) {
  const [nx, ny, nz, nt] = dims;
  let buf = data;
  const total = nx * ny * nz * nt;
  const passes = [
    { axisLen: nx, axisStride: 1 },
    { axisLen: ny, axisStride: nx },
    { axisLen: nz, axisStride: nx * ny },
    { axisLen: nt, axisStride: nx * ny * nz },
  ];
  for (let ax = 0; ax < 4; ax++) {
    const s = sigma[ax];
    if (s <= 0) continue;
    const kernel = gaussianKernel1D(s);
    const { axisLen, axisStride } = passes[ax];
    const out = new Float32Array(total);
    const outerCount = total / axisLen;
    let count = 0;
    for (let i = 0; i < total && count < outerCount; i++) {
      if (Math.floor(i / axisStride) % axisLen === 0) {
        convolve1DAxis(buf, out, i, axisLen, axisStride, kernel);
        count++;
      }
    }
    buf = out;
  }
  return buf;
}

function computeBaselineIntensity(data, dims, baselineVolumes, skipVolumes, trimLow, trimHigh) {
  if (trimLow + trimHigh >= baselineVolumes) {
    throw new Error('trimHigh + trimLow must be less than baselineVolumes.');
  }
  const [nx, ny, nz] = dims;
  const n3 = nx * ny * nz;
  const out = new Float32Array(n3);
  const win = new Float64Array(baselineVolumes);
  const keep = baselineVolumes - trimLow - trimHigh;
  for (let v = 0; v < n3; v++) {
    for (let k = 0; k < baselineVolumes; k++) {
      win[k] = data[v + (skipVolumes + k) * n3];
    }
    win.sort();
    let sum = 0;
    for (let k = trimLow; k < baselineVolumes - trimHigh; k++) sum += win[k];
    out[v] = sum / keep;
  }
  return out;
}

function computeGdConcentrationMap(mcData, baseline, mask, dims, echoTime, epsilon = 1e-6) {
  const [nx, ny, nz, nt] = dims;
  const n3 = nx * ny * nz;
  const baselineAdj = baseline.slice();
  let minInMaskBaseline = Infinity;
  for (let v = 0; v < n3; v++) {
    if (mask[v]) minInMaskBaseline = Math.min(minInMaskBaseline, baselineAdj[v]);
  }
  if (!Number.isFinite(minInMaskBaseline)) minInMaskBaseline = 0;
  for (let v = 0; v < n3; v++) {
    if (!mask[v]) baselineAdj[v] = minInMaskBaseline;
  }
  const gd = new Float32Array(n3 * nt);
  for (let t = 0; t < nt; t++) {
    const off = t * n3;
    for (let v = 0; v < n3; v++) {
      const ratio = Math.max(mcData[off + v] / (baselineAdj[v] + epsilon), epsilon);
      gd[off + v] = -(1 / echoTime) * Math.log(ratio);
    }
  }
  let minInMaskGd = Infinity;
  for (let t = 0; t < nt; t++) {
    const off = t * n3;
    for (let v = 0; v < n3; v++) {
      if (mask[v]) minInMaskGd = Math.min(minInMaskGd, gd[off + v]);
    }
  }
  if (!Number.isFinite(minInMaskGd)) minInMaskGd = 0;
  for (let t = 0; t < nt; t++) {
    const off = t * n3;
    for (let v = 0; v < n3; v++) {
      if (!mask[v]) gd[off + v] = minInMaskGd;
    }
  }
  return { gd, baseline: baselineAdj };
}

function peakProminence(x, peakIdx) {
  const n = x.length;
  const peakHeight = x[peakIdx];
  let leftBase = peakIdx;
  let leftMin = peakHeight;
  for (let i = peakIdx - 1; i >= 0; i--) {
    if (x[i] > peakHeight) break;
    if (x[i] < leftMin) {
      leftMin = x[i];
      leftBase = i;
    }
  }
  let rightBase = peakIdx;
  let rightMin = peakHeight;
  for (let i = peakIdx + 1; i < n; i++) {
    if (x[i] > peakHeight) break;
    if (x[i] < rightMin) {
      rightMin = x[i];
      rightBase = i;
    }
  }
  return { prominence: peakHeight - Math.max(leftMin, rightMin), leftBase, rightBase };
}

function peakWidth(x, peakIdx, prominence, leftBase, rightBase) {
  const widthHeight = x[peakIdx] - 0.5 * prominence;
  let leftIp = peakIdx;
  for (let i = peakIdx; i > leftBase; i--) {
    if (x[i - 1] <= widthHeight) {
      const denom = x[i] - x[i - 1];
      leftIp = denom !== 0 ? i - 1 + (widthHeight - x[i - 1]) / denom : i - 1;
      break;
    }
    leftIp = leftBase;
  }
  let rightIp = peakIdx;
  for (let i = peakIdx; i < rightBase; i++) {
    if (x[i + 1] <= widthHeight) {
      const denom = x[i] - x[i + 1];
      rightIp = denom !== 0 ? i + (x[i] - widthHeight) / denom : i;
      break;
    }
    rightIp = rightBase;
  }
  return rightIp - leftIp;
}

export function findSignalPeaks(signal, ts, params, skipVolumes, numPeaks) {
  const valid = [];
  for (let idx = 1; idx < signal.length - 1; idx++) {
    if (!(signal[idx] > signal[idx - 1] && signal[idx] > signal[idx + 1])) continue;
    const { prominence, leftBase, rightBase } = peakProminence(signal, idx);
    if (prominence < params.prominence) continue;
    if (signal[idx] < params.height) continue;
    const width = peakWidth(signal, idx, prominence, leftBase, rightBase);
    if (width < params.width) continue;
    if (idx > skipVolumes) valid.push(idx);
  }
  const out = new Float64Array(numPeaks).fill(NaN);
  if (valid.length === 0) return out;
  for (let k = 0; k < numPeaks; k++) {
    const idx = k < valid.length ? valid[k] : valid[valid.length - 1];
    out[k] = ts[idx];
  }
  return out;
}

function mode(values) {
  const counts = new Map();
  let best = values[0];
  let bestCount = 0;
  for (const v of values) {
    const c = (counts.get(v) || 0) + 1;
    counts.set(v, c);
    if (c > bestCount) {
      bestCount = c;
      best = v;
    }
  }
  return best;
}

function fillNanWithNeighbors(ttp, peakMap, numPeaks, mask, dims, neighborhood) {
  const [nx, ny, nz] = dims;
  const n3 = nx * ny * nz;
  const idx3 = (x, y, z) => x + y * nx + z * nx * ny;
  const out = ttp.slice();
  for (let v = 0; v < n3; v++) if (!mask[v]) out[v] = 0;
  const isNan = new Uint8Array(n3);
  for (let v = 0; v < n3; v++) isNan[v] = mask[v] && Number.isNaN(out[v]) ? 1 : 0;
  const known = (v) => mask[v] && !isNan[v];
  let prevUnfilled = -1;
  for (let iter = 0; iter < 200; iter++) {
    let unfilled = 0;
    for (let v = 0; v < n3; v++) if (isNan[v]) unfilled++;
    if (unfilled === 0 || unfilled === prevUnfilled) break;
    prevUnfilled = unfilled;
    const toFill = [];
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const v = idx3(x, y, z);
          if (!isNan[v]) continue;
          let adjacentKnown = false;
          for (let dz = -neighborhood[2]; dz <= neighborhood[2] && !adjacentKnown; dz++) {
            const zz = z + dz;
            if (zz < 0 || zz >= nz) continue;
            for (let dy = -neighborhood[1]; dy <= neighborhood[1] && !adjacentKnown; dy++) {
              const yy = y + dy;
              if (yy < 0 || yy >= ny) continue;
              for (let dx = -neighborhood[0]; dx <= neighborhood[0]; dx++) {
                const xx = x + dx;
                if (xx < 0 || xx >= nx) continue;
                if (known(idx3(xx, yy, zz))) {
                  adjacentKnown = true;
                  break;
                }
              }
            }
          }
          if (adjacentKnown) toFill.push(v);
        }
      }
    }
    const structSize =
      (2 * neighborhood[0] + 1) * (2 * neighborhood[1] + 1) * (2 * neighborhood[2] + 1);
    for (const v of toFill) {
      const z = Math.floor(v / (nx * ny));
      const y = Math.floor((v - z * nx * ny) / nx);
      const x = v - z * nx * ny - y * nx;
      const candidatePeaks = [];
      for (let dz = -neighborhood[2]; dz <= neighborhood[2]; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -neighborhood[1]; dy <= neighborhood[1]; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -neighborhood[0]; dx <= neighborhood[0]; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const nv = idx3(xx, yy, zz);
            const p0 = peakMap[nv];
            if (!Number.isNaN(p0) && !Number.isNaN(out[nv])) {
              candidatePeaks.push(p0);
            }
          }
        }
      }
      if (candidatePeaks.length > structSize / 3) {
        const modeVal = mode(candidatePeaks);
        const finiteTargets = [];
        for (let k = 0; k < numPeaks; k++) {
          const p = peakMap[k * n3 + v];
          if (!Number.isNaN(p)) finiteTargets.push(p);
        }
        let chosen = modeVal;
        if (finiteTargets.length > 0) {
          let best = finiteTargets[0];
          let bestDiff = Math.abs(best - modeVal);
          for (const p of finiteTargets) {
            const d = Math.abs(p - modeVal);
            if (d < bestDiff) {
              bestDiff = d;
              best = p;
            }
          }
          chosen = best;
        }
        out[v] = chosen;
        isNan[v] = 0;
      }
    }
  }
  for (let v = 0; v < n3; v++) if (!mask[v]) out[v] = 0;
  return out;
}

function denoiseTtp(ttpIn, mask, dims, pixdim3, params) {
  const [nx, ny, nz] = dims;
  const n3 = nx * ny * nz;
  const [dx, dy, dz] = pixdim3;
  const validBrain = new Uint8Array(n3);
  const validValues = [];
  for (let v = 0; v < n3; v++) {
    if (mask[v] > 0 && !Number.isNaN(ttpIn[v])) {
      validBrain[v] = 1;
      validValues.push(ttpIn[v]);
    }
  }
  if (!validValues.length) return new Float32Array(n3);
  const meanTtp = validValues.reduce((a, b) => a + b, 0) / validValues.length;
  const variance = validValues.reduce((a, b) => a + (b - meanTtp) ** 2, 0) / validValues.length;
  const stdTtp = Math.sqrt(variance);
  const sorted = validValues.slice().sort((a, b) => a - b);
  const quantile = (q) => {
    const pos = q * (sorted.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return lo === hi ? sorted[lo] : sorted[lo] + (pos - lo) * (sorted[hi] - sorted[lo]);
  };
  const [upperZ, lowerZ] = params.zThresholds;
  const [upperQ, lowerQ] = params.quantileThresholds;
  const upperQuantile = quantile(upperQ);
  const lowerQuantile = quantile(lowerQ);

  const knownCoords = [];
  const knownValues = [];
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const v = x + y * nx + z * nx * ny;
        if (!validBrain[v]) continue;
        const val = ttpIn[v];
        if (
          val < upperQuantile + 0.01 &&
          val > lowerQuantile - 0.01 &&
          val < meanTtp + upperZ * stdTtp &&
          val > meanTtp - lowerZ * stdTtp
        ) {
          knownCoords.push(x * dx, y * dy, z * dz);
          knownValues.push(val);
        }
      }
    }
  }
  const out = new Float32Array(n3);
  if (!knownValues.length) return out;
  const cellSize = Math.max(dx, dy, dz) * 4;
  const grid = new Map();
  const cellKey = (cx, cy, cz) => `${cx},${cy},${cz}`;
  for (let k = 0; k < knownValues.length; k++) {
    const key = cellKey(
      Math.floor(knownCoords[k * 3] / cellSize),
      Math.floor(knownCoords[k * 3 + 1] / cellSize),
      Math.floor(knownCoords[k * 3 + 2] / cellSize),
    );
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key).push(k);
  }
  const maxRing = Math.max(nx, ny, nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const v = x + y * nx + z * nx * ny;
        if (!mask[v]) continue;
        const qx = x * dx;
        const qy = y * dy;
        const qz = z * dz;
        const cx = Math.floor(qx / cellSize);
        const cy = Math.floor(qy / cellSize);
        const cz = Math.floor(qz / cellSize);
        let bestDist = Infinity;
        let bestVal = knownValues[0];
        let ring = 0;
        let found = false;
        while (!found && ring < maxRing) {
          for (let ddz = -ring; ddz <= ring; ddz++) {
            for (let ddy = -ring; ddy <= ring; ddy++) {
              for (let ddx = -ring; ddx <= ring; ddx++) {
                if (Math.max(Math.abs(ddx), Math.abs(ddy), Math.abs(ddz)) !== ring) continue;
                const bucket = grid.get(cellKey(cx + ddx, cy + ddy, cz + ddz));
                if (!bucket) continue;
                for (const k of bucket) {
                  const rx = knownCoords[k * 3] - qx;
                  const ry = knownCoords[k * 3 + 1] - qy;
                  const rz = knownCoords[k * 3 + 2] - qz;
                  const dist = rx * rx + ry * ry + rz * rz;
                  if (dist < bestDist) {
                    bestDist = dist;
                    bestVal = knownValues[k];
                    found = true;
                  }
                }
              }
            }
          }
          ring++;
          if (found && ring > 2) break;
        }
        out[v] = bestVal;
      }
    }
  }
  return out;
}

export function computeTtpVolume({
  pwi,
  dims,
  pixdim,
  mask,
  sliceTiming = null,
  skipSliceTimeCorrection = false,
  echoTime = TTP_DEFAULTS.echoTime,
  onProgress = () => {},
}) {
  const [nx, ny, nz, nt] = dims;
  const minFrames = TTP_DEFAULTS.baselineVolumesMin + TTP_DEFAULTS.skipVolumes + 3;
  if (!Number.isInteger(nt) || nt < minFrames) {
    throw new Error(`4D PWI series requires at least ${minFrames} time frames for baseline and peak detection (received ${nt}).`);
  }
  if (!Number.isFinite(echoTime) || echoTime <= 0) {
    throw new Error(`Invalid PWI EchoTime (${echoTime}).`);
  }
  const dims3 = [nx, ny, nz];
  const pixdim3 = [pixdim[0], pixdim[1], pixdim[2]];
  const tr = Number.isFinite(pixdim[3]) && pixdim[3] > 0 ? pixdim[3] : 1.7;

  let stc;
  let timeRef;
  if (skipSliceTimeCorrection) {
    stc = pwi;
    timeRef = new Float64Array(nt);
    for (let t = 0; t < nt; t++) timeRef[t] = tr * t;
  } else {
    onProgress('Slice-time correction');
    const stcRes = sliceTimeCorrection(pwi, dims, tr, sliceTiming);
    stc = stcRes.data;
    timeRef = stcRes.timeRef;
  }
  const baselineVolumes = Math.max(
    TTP_DEFAULTS.baselineVolumesMin,
    Math.round(nt * TTP_DEFAULTS.baselinePercentage),
  );
  const skipVolumesForPeaks = baselineVolumes + TTP_DEFAULTS.skipVolumes;

  onProgress('Gd concentration map');
  const scaling = 2 * Math.sqrt(2 * Math.log(2));
  const sigma4 = [
    TTP_DEFAULTS.fwhmSpatial / pixdim[0] / scaling,
    TTP_DEFAULTS.fwhmSpatial / pixdim[1] / scaling,
    TTP_DEFAULTS.fwhmSpatial / pixdim[2] / scaling,
    TTP_DEFAULTS.fwhmTemporal / tr / scaling,
  ];
  const filtered = gaussianFilter4D(stc, dims, sigma4);
  const baseline = computeBaselineIntensity(
    filtered,
    dims,
    baselineVolumes,
    TTP_DEFAULTS.skipVolumes,
    TTP_DEFAULTS.trimLow,
    TTP_DEFAULTS.trimHigh,
  );
  const { gd } = computeGdConcentrationMap(filtered, baseline, mask, dims, echoTime);

  onProgress('Per-voxel peak detection');
  const n3 = nx * ny * nz;
  const peakMap = new Float32Array(n3 * TTP_DEFAULTS.numPeaks).fill(NaN);
  const signal = new Float64Array(nt);
  const tsSeconds = new Float64Array(nt);
  for (let t = 0; t < nt; t++) tsSeconds[t] = t * tr;
  for (let v = 0; v < n3; v++) {
    if (!mask[v]) continue;
    for (let t = 0; t < nt; t++) signal[t] = gd[v + t * n3];
    const peaks = findSignalPeaks(signal, tsSeconds, TTP_DEFAULTS.peak, skipVolumesForPeaks, TTP_DEFAULTS.numPeaks);
    for (let k = 0; k < TTP_DEFAULTS.numPeaks; k++) peakMap[k * n3 + v] = peaks[k];
  }

  onProgress('Neighbor fill and denoising');
  const ttpFirst = new Float32Array(n3).fill(NaN);
  for (let v = 0; v < n3; v++) if (mask[v]) ttpFirst[v] = peakMap[v];
  const filled = fillNanWithNeighbors(ttpFirst, peakMap, TTP_DEFAULTS.numPeaks, mask, dims3, TTP_DEFAULTS.neighborhood);
  const ttp = denoiseTtp(filled, mask, dims3, pixdim3, {
    zThresholds: TTP_DEFAULTS.zThresholds,
    quantileThresholds: TTP_DEFAULTS.quantileThresholds,
  });
  return { ttp, dims: dims3, timeRefSeconds: Array.from(timeRef), baselineVolumes };
}
