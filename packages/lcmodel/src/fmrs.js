// Functional MRS (fMRS) paradigm parsing, temporal/condition binning, QC
// classification, windowed temporal GLM, 2D dynamic spectral GLM fitting,
// CSV exports and printable HTML report. Pure, Node-tested.

import { metaboliteNames } from "./group.js";
import { qcTimeCourseSvg, timeCourseSvg, transientDriftSvg } from "./fmrs-plot.js";
import { formatConc, SD_LIMIT } from "./report.js";

/** Default fMRS QC thresholds (matching standard 7T/3T LCModel QC practice). */
export const FMRS_QC_THRESHOLDS = Object.freeze({
  fwhmFailPpm: 0.1,
  fwhmWarnPpm: 0.05,
  snrFail: 10,
  snrWarn: 20,
  shiftWarnPpm: 0.1,
  ph0WarnDeg: 30,
  ph1WarnDegPerPpm: 10,
  outlierZ: 3.0,
});

// ---------------------------------------------------------------------------
// Paradigm / BIDS events parsing
// ---------------------------------------------------------------------------

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

/**
 * Parse a BIDS `events.tsv` or CSV stimulus schedule.
 * Required columns: `onset` (seconds, may be negative per BIDS), `duration`
 * (seconds, >= 0; 0 denotes an instantaneous event), and one of `trial_type`,
 * `condition`, `event`, or `label`.
 * @returns {{ onset: number, duration: number, condition: string }[]}
 */
export function parseEventsText(text) {
  const rawLines = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .filter((l) => {
      const trimmed = l.trim();
      return trimmed.length > 0 && !trimmed.startsWith("#");
    });
  if (rawLines.length < 2) {
    throw new Error("Events file must contain a header row and at least one event row.");
  }
  const delimiter = rawLines[0].includes("\t") ? "\t" : ",";
  const headers = splitDelimitedLine(rawLines[0], delimiter).map((h) => h.toLowerCase());
  const onsetCol = headers.findIndex((h) => h === "onset" || h === "onset_s" || h === "start" || h === "start_s");
  const durCol = headers.findIndex((h) => h === "duration" || h === "duration_s" || h === "dur");
  const condCol = headers.findIndex((h) => ["trial_type", "condition", "event", "label", "name", "stimulus"].includes(h));
  if (onsetCol < 0 || durCol < 0 || condCol < 0) {
    throw new Error("Events file needs onset, duration, and trial_type (or condition) columns.");
  }
  const events = [];
  for (let r = 1; r < rawLines.length; r += 1) {
    const cols = splitDelimitedLine(rawLines[r], delimiter);
    const rawOnset = (cols[onsetCol] ?? "").trim();
    const rawDur = (cols[durCol] ?? "").trim();
    const condition = (cols[condCol] ?? "").trim();
    if (!rawOnset || !Number.isFinite(Number(rawOnset))) {
      throw new Error(`Events row ${r + 1}: onset "${rawOnset}" must be a finite number.`);
    }
    if (!rawDur || !Number.isFinite(Number(rawDur)) || Number(rawDur) < 0) {
      throw new Error(`Events row ${r + 1}: duration "${rawDur}" must be a non-negative number.`);
    }
    const onset = Number(rawOnset);
    const duration = Number(rawDur);
    if (!condition || condition.toLowerCase() === "n/a") continue;
    events.push({ onset, duration, condition });
  }
  if (!events.length) throw new Error("No valid events with non-empty trial_type/condition were found.");
  events.sort((a, b) => a.onset - b.onset || a.duration - b.duration);
  return events;
}

function mergedLength(intervals) {
  if (!intervals.length) return 0;
  const sorted = [...intervals].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let curLo = sorted[0][0];
  let curHi = sorted[0][1];
  for (let i = 1; i < sorted.length; i += 1) {
    const [lo, hi] = sorted[i];
    if (lo <= curHi) {
      curHi = Math.max(curHi, hi);
    } else {
      total += curHi - curLo;
      curLo = lo;
      curHi = hi;
    }
  }
  return total + (curHi - curLo);
}

/**
 * Dominant condition label overlapping `[startS, endS]`, merging overlapping
 * annotations per condition (so duplicate/overlapping annotations cannot
 * double-count duration) and accounting for uncovered implicit baseline
 * (`fallback`) duration. Zero-duration impulse events match their containing
 * `[startS, endS)` interval when no positive-duration event overlaps.
 */
export function conditionForInterval(events, startS, endS, fallback = null) {
  if (!events?.length) return fallback;
  const span = Math.max(0, endS - startS);
  const byCondition = new Map();
  const coveredIntervals = [];
  const impulses = new Map();

  for (const ev of events) {
    if (ev.duration === 0) {
      if (ev.onset >= startS - 1e-9 && ev.onset < endS - 1e-9) {
        impulses.set(ev.condition, (impulses.get(ev.condition) ?? 0) + 1);
      }
      continue;
    }
    const lo = Math.max(startS, ev.onset);
    const hi = Math.min(endS, ev.onset + ev.duration);
    if (hi - lo > 1e-6) {
      if (!byCondition.has(ev.condition)) byCondition.set(ev.condition, []);
      byCondition.get(ev.condition).push([lo, hi]);
      coveredIntervals.push([lo, hi]);
    }
  }

  if (!byCondition.size) {
    if (impulses.size) {
      let best = null;
      let bestCount = -1;
      for (const [cond, count] of impulses) {
        if (count > bestCount) {
          best = cond;
          bestCount = count;
        }
      }
      return best ?? fallback;
    }
    return fallback;
  }

  const totals = new Map();
  for (const [cond, intervals] of byCondition) {
    totals.set(cond, mergedLength(intervals));
  }
  const covered = mergedLength(coveredIntervals);
  const uncovered = Math.max(0, span - covered);
  if (fallback != null && uncovered > 1e-6) {
    totals.set(fallback, (totals.get(fallback) ?? 0) + uncovered);
  }

  let best = null;
  let bestDur = -1;
  for (const [cond, dur] of totals) {
    if (dur > bestDur) {
      best = cond;
      bestDur = dur;
    }
  }
  return best ?? fallback;
}

/**
 * Build an fMRS binning plan for `averages` raw transients on a fixed-TR
 * acquisition timeline (`k * trS` seconds for transient `k`, assuming no
 * mid-scan pauses or irregular inter-transient delays).
 *
 * Modes:
 * - `"sliding"`: fixed or sliding windows (`windowSize`, `stepSize`).
 * - `"blocks"`: contiguous transient runs grouped by event condition.
 * - `"conditions"`: all transients of each condition pooled into one spectrum.
 */
export function buildFmrsBins({
  mode = "sliding",
  averages,
  trS,
  windowSize = 4,
  stepSize = windowSize,
  events = [],
  baselineLabel = "Rest",
}) {
  if (!Number.isInteger(averages) || averages < 2) {
    throw new Error("Functional MRS binning needs at least 2 transients.");
  }
  if (!Number.isFinite(trS) || !(trS > 0)) {
    throw new Error("Functional MRS binning requires a valid positive repetition time (TR).");
  }
  const tr = trS;
  const hasEvents = Array.isArray(events) && events.length > 0;

  if (mode === "sliding") {
    const winNum = Number(windowSize);
    if (!Number.isInteger(winNum) || winNum < 1) {
      throw new Error(`fMRS window size must be a positive integer, not "${windowSize}".`);
    }
    const stepNum = stepSize == null ? winNum : Number(stepSize);
    if (!Number.isInteger(stepNum) || stepNum < 1) {
      throw new Error(`fMRS step size must be a positive integer, not "${stepSize}".`);
    }
    if (winNum > averages) {
      throw new Error(`Window size (${winNum}) exceeds the number of averages (${averages}).`);
    }
    const bins = [];
    for (let start = 0; start + winNum <= averages; start += stepNum) {
      const end = start + winNum;
      const startTimeS = start * tr;
      const endTimeS = end * tr;
      const condition = hasEvents ? conditionForInterval(events, startTimeS, endTimeS, baselineLabel) : null;
      const idx = bins.length + 1;
      const indices = Array.from({ length: winNum }, (_, k) => start + k);
      bins.push({
        id: `win_${String(idx).padStart(2, "0")}`,
        label: condition ? `${condition} #${idx}` : `Window ${idx}`,
        condition,
        indices,
        startTimeS,
        endTimeS,
      });
    }
    if (!bins.length) throw new Error(`Window size (${winNum}) exceeds the number of averages (${averages}).`);
    return bins;
  }

  if (!hasEvents) {
    throw new Error(`fMRS mode "${mode}" requires a stimulus events file (BIDS events.tsv or CSV).`);
  }

  const perTransient = Array.from({ length: averages }, (_, k) =>
    conditionForInterval(events, k * tr, (k + 1) * tr, baselineLabel),
  );

  if (mode === "blocks") {
    const bins = [];
    let start = 0;
    while (start < averages) {
      const cond = perTransient[start];
      let end = start + 1;
      while (end < averages && perTransient[end] === cond) end += 1;
      const idx = bins.length + 1;
      bins.push({
        id: `blk_${String(idx).padStart(2, "0")}`,
        label: `${cond} (block ${idx})`,
        condition: cond,
        indices: Array.from({ length: end - start }, (_, k) => start + k),
        startTimeS: start * tr,
        endTimeS: end * tr,
      });
      start = end;
    }
    return bins;
  }

  if (mode === "conditions") {
    const grouped = new Map();
    perTransient.forEach((cond, k) => {
      if (!grouped.has(cond)) grouped.set(cond, []);
      grouped.get(cond).push(k);
    });
    const bins = [];
    const usedIds = new Set();
    for (const [cond, indices] of grouped) {
      const base = `cond_${cond.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || bins.length + 1}`;
      let id = base;
      let suffix = 2;
      while (usedIds.has(id)) {
        id = `${base}_${suffix}`;
        suffix += 1;
      }
      usedIds.add(id);
      bins.push({
        id,
        label: cond,
        condition: cond,
        indices,
        startTimeS: indices[0] * tr,
        endTimeS: (indices.at(-1) + 1) * tr,
      });
    }
    return bins;
  }

  throw new Error(`Unknown fMRS binning mode "${mode}".`);
}

// ---------------------------------------------------------------------------
// Basic statistics & linear algebra (pure, zero dependencies)
// ---------------------------------------------------------------------------

function median(values) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
}

function mean(values) {
  const v = values.filter(Number.isFinite);
  if (!v.length) return null;
  return v.reduce((a, b) => a + b, 0) / v.length;
}

function sampleSd(values) {
  const v = values.filter(Number.isFinite);
  if (v.length < 2) return null;
  const mu = mean(v);
  const ss = v.reduce((acc, x) => acc + (x - mu) ** 2, 0);
  return Math.sqrt(ss / (v.length - 1));
}

function logGamma(z) {
  const c = [
    76.18009172947146,
    -86.50532032941678,
    24.01409824083091,
    -1.231739572450155,
    0.001208650973866179,
    -0.000005395239384953,
  ];
  let x = z;
  let y = z;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (let j = 0; j < 6; j += 1) {
    y += 1;
    ser += c[j] / y;
  }
  return -tmp + Math.log((Math.sqrt(2 * Math.PI) * ser) / x);
}

function betacf(a, b, x) {
  const fpmin = 1e-30;
  const eps = 3e-12;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < fpmin) d = fpmin;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < fpmin) d = fpmin;
    c = 1 + aa / c;
    if (Math.abs(c) < fpmin) c = fpmin;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < eps) break;
  }
  return h;
}

function regularizedBeta(a, b, x) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  if (x < (a + 1) / (a + b + 2)) return (bt * betacf(a, b, x)) / a;
  return 1 - (bt * betacf(b, a, 1 - x)) / b;
}

/** Exact two-tailed Student-t p-value for statistic `t` and degrees of freedom `df`. */
export function studentTwoTailedP(t, df) {
  if (!Number.isFinite(t) || !Number.isFinite(df) || df <= 0) return null;
  if (t === 0) return 1;
  const x = df / (df + t * t);
  return Math.max(0, Math.min(1, regularizedBeta(df / 2, 0.5, x)));
}

/** Invert a small square matrix with Gauss-Jordan partial pivoting; null if singular. */
export function invertMatrix(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col += 1) {
    let pivot = col;
    let maxAbs = Math.abs(M[col][col]);
    for (let r = col + 1; r < n; r += 1) {
      const v = Math.abs(M[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivot = r;
      }
    }
    if (!(maxAbs > 1e-12)) return null;
    if (pivot !== col) [M[col], M[pivot]] = [M[pivot], M[col]];
    const diag = M[col][col];
    for (let j = col; j < 2 * n; j += 1) M[col][j] /= diag;
    for (let r = 0; r < n; r += 1) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let j = col; j < 2 * n; j += 1) M[r][j] -= factor * M[col][j];
    }
  }
  return M.map((row) => row.slice(n));
}

/**
 * Rank-revealing Householder QR ordinary least squares with optional
 * Newey-West HAC standard errors (Bartlett kernel) for serially correlated
 * time series. Returns `{ rankDeficient: true }` when `X` is ill-conditioned
 * or collinear, or `null` when `n <= p`.
 */
const ZERO_RESIDUAL_VAR_TOL = 1e-20;

function fitOls(X, y, { hac = false } = {}) {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n <= p || p === 0) return null;

  const scales = new Array(p).fill(0);
  for (let j = 0; j < p; j += 1) {
    let s2 = 0;
    for (let i = 0; i < n; i += 1) s2 += X[i][j] * X[i][j];
    scales[j] = Math.sqrt(s2);
    if (!(scales[j] > 1e-12)) return { rankDeficient: true };
  }

  // Scaled copy A (n x p) and y copy for Q^T y.
  const A = X.map((row) => row.map((v, j) => v / scales[j]));
  const qty = [...y];

  for (let col = 0; col < p; col += 1) {
    let norm2 = 0;
    for (let i = col; i < n; i += 1) norm2 += A[i][col] * A[i][col];
    const norm = Math.sqrt(norm2);
    if (!(norm > 1e-12)) return { rankDeficient: true };
    const sign = A[col][col] >= 0 ? 1 : -1;
    const v0 = A[col][col] + sign * norm;
    const v = new Array(n - col);
    v[0] = v0;
    let vNorm2 = v0 * v0;
    for (let i = col + 1; i < n; i += 1) {
      v[i - col] = A[i][col];
      vNorm2 += A[i][col] * A[i][col];
    }
    const factor = 2 / vNorm2;
    for (let j = col; j < p; j += 1) {
      let dot = 0;
      for (let i = col; i < n; i += 1) dot += v[i - col] * A[i][j];
      const scale = factor * dot;
      for (let i = col; i < n; i += 1) A[i][j] -= scale * v[i - col];
    }
    let dotY = 0;
    for (let i = col; i < n; i += 1) dotY += v[i - col] * qty[i];
    const scaleY = factor * dotY;
    for (let i = col; i < n; i += 1) qty[i] -= scaleY * v[i - col];
  }

  let rMax = 0;
  let rMin = Infinity;
  for (let j = 0; j < p; j += 1) {
    const d = Math.abs(A[j][j]);
    if (d > rMax) rMax = d;
    if (d < rMin) rMin = d;
  }
  if (!(rMax > 1e-12) || rMin / rMax <= 1e-7) {
    return { rankDeficient: true };
  }

  // Back-substitute R * beta_s = qty[0..p].
  const betaScaled = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i -= 1) {
    let sum = qty[i];
    for (let j = i + 1; j < p; j += 1) sum -= A[i][j] * betaScaled[j];
    betaScaled[i] = sum / A[i][i];
  }
  const beta = betaScaled.map((v, j) => v / scales[j]);

  // Upper-triangular inverse R^{-1}.
  const Rinv = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let k = 0; k < p; k += 1) {
    Rinv[k][k] = 1 / A[k][k];
    for (let i = k - 1; i >= 0; i -= 1) {
      let sum = 0;
      for (let j = i + 1; j <= k; j += 1) sum -= A[i][j] * Rinv[j][k];
      Rinv[i][k] = sum / A[i][i];
    }
  }

  // (X^T X)^{-1} = S^{-1} R^{-1} (R^{-1})^T S^{-1}.
  const XtXinv = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let a = 0; a < p; a += 1) {
    for (let b = a; b < p; b += 1) {
      let s = 0;
      for (let k = Math.max(a, b); k < p; k += 1) s += Rinv[a][k] * Rinv[b][k];
      const v = s / (scales[a] * scales[b]);
      XtXinv[a][b] = v;
      XtXinv[b][a] = v;
    }
  }

  const resid = new Array(n);
  let rss = 0;
  for (let i = 0; i < n; i += 1) {
    let pred = 0;
    for (let a = 0; a < p; a += 1) pred += X[i][a] * beta[a];
    const e = y[i] - pred;
    resid[i] = e;
    rss += e * e;
  }
  const df = n - p;
  const sigma2 = rss / df;
  const yScale2 = Math.max(1e-30, y.reduce((s, v) => s + v * v, 0) / n);
  const zeroResidualVariance = !(sigma2 > ZERO_RESIDUAL_VAR_TOL * yScale2);

  let se;
  let hacLag = 0;
  let rho1 = 0;
  if (hac) {
    // Andrews (1991) AR(1)-adaptive Bartlett bandwidth with Prais-Winsten
    // fallback floor so serially correlated window/transient series keep
    // calibrated standard errors.
    let numRho = 0;
    let denRho = 0;
    for (let i = 1; i < n; i += 1) numRho += resid[i] * resid[i - 1];
    for (let i = 0; i < n; i += 1) denRho += resid[i] * resid[i];
    rho1 = denRho > 1e-24 ? Math.max(-0.9, Math.min(0.9, numRho / denRho)) : 0;
    const nwLag = Math.floor(4 * (n / 100) ** (2 / 9));
    const alpha1 = (4 * rho1 * rho1) / ((1 - rho1 * rho1) ** 2);
    const andrewsLag = Math.abs(rho1) > 1e-6 ? Math.ceil(1.1447 * (alpha1 * n) ** (1 / 3)) : 0;
    hacLag = n >= 8 ? Math.max(1, Math.min(Math.max(nwLag, andrewsLag), Math.floor((n - 1) / 2))) : 0;

    // Prewhiten scores with AR(1) on residuals (Andrews & Monahan 1992) when
    // positive serial correlation is present so finite-sample Bartlett weights
    // do not understate variance at high AR(1) correlation (e.g. rho = 0.8).
    const phi = n >= 8 && Math.abs(rho1) > 0.05 ? Math.max(-0.85, Math.min(0.85, rho1)) : 0;
    const rawScores = X.map((row, i) => row.map((v) => v * resid[i]));
    const scores = phi !== 0
      ? rawScores.slice(1).map((row, idx) => row.map((v, a) => v - phi * rawScores[idx][a]))
      : rawScores;
    const m = scores.length;
    const preLag = phi !== 0 ? Math.max(1, Math.min(nwLag, Math.floor((m - 1) / 3))) : hacLag;

    const meat = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let i = 0; i < m; i += 1) {
      const si = scores[i];
      for (let a = 0; a < p; a += 1) {
        for (let b = a; b < p; b += 1) meat[a][b] += si[a] * si[b];
      }
    }
    for (let lag = 1; lag <= preLag; lag += 1) {
      const w = 1 - lag / (preLag + 1);
      for (let i = lag; i < m; i += 1) {
        const si = scores[i];
        const sj = scores[i - lag];
        for (let a = 0; a < p; a += 1) {
          for (let b = a; b < p; b += 1) {
            meat[a][b] += w * (si[a] * sj[b] + sj[a] * si[b]);
          }
        }
      }
    }
    for (let a = 0; a < p; a += 1) {
      for (let b = 0; b < a; b += 1) meat[a][b] = meat[b][a];
    }
    // Recolor by 1 / (1 - phi)^2 and scale for degrees of freedom (n / m) * (n / df).
    const recolor = phi !== 0 ? (n / m) / ((1 - phi) ** 2) : 1;
    const scaleSmall = (n / df) * recolor;
    se = new Array(p).fill(0);
    for (let a = 0; a < p; a += 1) {
      let variance = 0;
      for (let u = 0; u < p; u += 1) {
        const xau = XtXinv[a][u];
        for (let v = 0; v < p; v += 1) variance += xau * meat[u][v] * XtXinv[v][a];
      }
      se[a] = Math.sqrt(Math.max(0, scaleSmall * variance));
    }
  } else {
    se = XtXinv.map((row, k) => Math.sqrt(Math.max(0, sigma2 * row[k])));
  }

  return { rankDeficient: false, zeroResidualVariance, beta, se, df, sigma2, rss, conditionNumber: rMax / rMin, hacLag, rho1 };
}

/**
 * Exact continuous-time AR(1) (`CAR(1)`) REML generalized least squares
 * (`rho in [0, 0.95]` per median step `dtRef`) using exact bidiagonal Cholesky
 * whitening and rank-revealing Householder QR. Reduces identically to exact
 * Prais-Winsten REML on equally spaced windows while correctly decaying
 * correlation as `rho^(dt / dtRef)` across unequal blocks or QC-excluded gaps.
 */
function fitRemlAr1(X, y, times = null) {
  const n = y.length;
  const p = X[0]?.length ?? 0;
  if (n <= p + 1 || p === 0) return null;

  // Sort observations by timestamp when provided so the Markov AR(1) chain
  // follows true acquisition order.
  const order = Array.from({ length: n }, (_, i) => i);
  if (Array.isArray(times) && times.length === n) {
    order.sort((a, b) => (times[a] - times[b]) || (a - b));
  }
  const Xs = order.map((i) => X[i]);
  const ys = order.map((i) => y[i]);
  const ts = Array.isArray(times) && times.length === n ? order.map((i) => times[i]) : order;

  const posDts = [];
  for (let i = 1; i < n; i += 1) {
    const dt = ts[i] - ts[i - 1];
    if (Number.isFinite(dt) && dt > 1e-9) posDts.push(dt);
  }
  const dtRef = posDts.length ? median(posDts) : 1;
  const deltas = new Array(n).fill(1);
  deltas[0] = 0;
  for (let i = 1; i < n; i += 1) {
    const dt = ts[i] - ts[i - 1];
    deltas[i] = Number.isFinite(dt) && dt > 1e-9 ? dt / dtRef : 1;
  }

  const yScale2 = Math.max(1e-30, ys.reduce((s, v) => s + v * v, 0) / n);
  const df = n - p - 1;
  if (df < 1) return null;
  const rssFloor = ZERO_RESIDUAL_VAR_TOL * yScale2 * df;

  const evalRho = (rho) => {
    const Xw = new Array(n);
    const yw = new Array(n);
    Xw[0] = [...Xs[0]];
    yw[0] = ys[0];
    let logDetV = 0;
    for (let i = 1; i < n; i += 1) {
      const r = rho === 0 ? 0 : rho ** deltas[i];
      const v = Math.max(1e-12, 1 - r * r);
      const invSqrtV = 1 / Math.sqrt(v);
      logDetV += Math.log(v);
      const prevX = Xs[i - 1];
      const curX = Xs[i];
      Xw[i] = curX.map((val, j) => invSqrtV * (val - r * prevX[j]));
      yw[i] = invSqrtV * (ys[i] - r * ys[i - 1]);
    }
    const scales = new Array(p).fill(0);
    for (let j = 0; j < p; j += 1) {
      let s2 = 0;
      for (let i = 0; i < n; i += 1) s2 += Xw[i][j] * Xw[i][j];
      scales[j] = Math.sqrt(s2);
      if (!(scales[j] > 1e-12)) return null;
    }
    const A = Xw.map((row) => row.map((v, j) => v / scales[j]));
    const qty = [...yw];
    for (let col = 0; col < p; col += 1) {
      let norm2 = 0;
      for (let i = col; i < n; i += 1) norm2 += A[i][col] * A[i][col];
      const norm = Math.sqrt(norm2);
      if (!(norm > 1e-12)) return null;
      const sign = A[col][col] >= 0 ? 1 : -1;
      const v0 = A[col][col] + sign * norm;
      const v = new Array(n - col);
      v[0] = v0;
      let v2 = v0 * v0;
      for (let i = col + 1; i < n; i += 1) {
        v[i - col] = A[i][col];
        v2 += A[i][col] * A[i][col];
      }
      const f = 2 / v2;
      for (let j = col; j < p; j += 1) {
        let d = 0;
        for (let i = col; i < n; i += 1) d += v[i - col] * A[i][j];
        const s = f * d;
        for (let i = col; i < n; i += 1) A[i][j] -= s * v[i - col];
      }
      let dy = 0;
      for (let i = col; i < n; i += 1) dy += v[i - col] * qty[i];
      const sy = f * dy;
      for (let i = col; i < n; i += 1) qty[i] -= sy * v[i - col];
    }
    let rMax = 0;
    let rMin = Infinity;
    let logDetXtVinvX = 0;
    for (let j = 0; j < p; j += 1) {
      const d = Math.abs(A[j][j]);
      if (d > rMax) rMax = d;
      if (d < rMin) rMin = d;
      logDetXtVinvX += 2 * Math.log(d * scales[j]);
    }
    if (!(rMax > 1e-12) || rMin / rMax <= 1e-7) return null;
    const betaScaled = new Array(p).fill(0);
    for (let i = p - 1; i >= 0; i -= 1) {
      let sum = qty[i];
      for (let j = i + 1; j < p; j += 1) sum -= A[i][j] * betaScaled[j];
      betaScaled[i] = sum / A[i][i];
    }
    const beta = betaScaled.map((v, j) => v / scales[j]);
    let rss = 0;
    for (let i = p; i < n; i += 1) rss += qty[i] * qty[i];
    const Rinv = Array.from({ length: p }, () => new Array(p).fill(0));
    for (let k = 0; k < p; k += 1) {
      Rinv[k][k] = 1 / A[k][k];
      for (let i = k - 1; i >= 0; i -= 1) {
        let sum = 0;
        for (let j = i + 1; j <= k; j += 1) sum -= A[i][j] * Rinv[j][k];
        Rinv[i][k] = sum / A[i][i];
      }
    }
    const diag = Array.from({ length: p }, (_, a) => {
      let s = 0;
      for (let k = a; k < p; k += 1) s += Rinv[a][k] * Rinv[a][k];
      return s / (scales[a] * scales[a]);
    });
    const nll = logDetV + logDetXtVinvX + (n - p) * Math.log(Math.max(rssFloor, rss));
    return { nll, rho, beta, rss, diag };
  };

  let best = evalRho(0);
  if (!best) return { rankDeficient: true };
  if (!(best.rss > rssFloor)) {
    return {
      rankDeficient: false,
      zeroResidualVariance: true,
      beta: best.beta,
      se: null,
      df,
      sigma2: 0,
      rss: 0,
      ar1Rho: 0,
      dtRef,
    };
  }
  for (let k = 1; k <= 19; k += 1) {
    const cand = evalRho(k / 20);
    if (cand && cand.nll < best.nll) best = cand;
  }
  let lo = Math.max(0, best.rho - 0.05);
  let hi = Math.min(0.95, best.rho + 0.05);
  for (let step = 0; step < 10; step += 1) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    const c1 = evalRho(m1);
    const c2 = evalRho(m2);
    if (c1 && (!c2 || c1.nll < c2.nll)) {
      hi = m2;
      if (c1.nll < best.nll) best = c1;
    } else if (c2) {
      lo = m1;
      if (c2.nll < best.nll) best = c2;
    }
  }
  const sigma2 = best.rss / df;
  if (!(sigma2 > ZERO_RESIDUAL_VAR_TOL * yScale2)) {
    return {
      rankDeficient: false,
      zeroResidualVariance: true,
      beta: best.beta,
      se: null,
      df,
      sigma2: 0,
      rss: 0,
      ar1Rho: best.rho,
      dtRef,
    };
  }
  const se = best.diag.map((d) => Math.sqrt(Math.max(0, sigma2 * d)));
  return { rankDeficient: false, zeroResidualVariance: false, beta: best.beta, se, df, sigma2, rss: best.rss, ar1Rho: best.rho, dtRef };
}

// ---------------------------------------------------------------------------
// QC classification
// ---------------------------------------------------------------------------

function metaboliteValue(record, names) {
  for (const name of names) {
    const hit = record.metabolites?.find((m) => m.name === name);
    if (hit && Number.isFinite(hit.concentration)) return { value: hit.concentration, name };
  }
  return null;
}

/** Pick the reference/baseline condition label among observed conditions. */
export function chooseBaselineCondition(conditions) {
  const uniq = [...new Set(conditions.filter(Boolean))];
  if (!uniq.length) return null;
  const rest = uniq.find((c) => /^(rest|baseline|control|saline|off|pre|complete\s*rest)/i.test(c));
  return rest ?? uniq[0];
}

/**
 * Classify each fMRS window into PASS / WARN / FAIL using consensus LCModel
 * quality thresholds, compute tNAA/tCr (noting single-peak NAA/Cr fallback)
 * and linewidth in Hz, and summarize per condition.
 */
export function classifyWindowQc(windows, { hzpppm = null, baselineCondition = null, thresholds = FMRS_QC_THRESHOLDS } = {}) {
  const enriched = windows.map((w) => {
    const tNaa = metaboliteValue(w, ["NAA+NAAG", "tNAA", "NAA"]);
    const tCr = metaboliteValue(w, ["Cr+PCr", "tCr", "Cr"]);
    const tNaaToTCr = tNaa != null && tCr != null && tCr.value > 0 ? tNaa.value / tCr.value : null;
    const tNaaToTCrBasis = tNaaToTCr == null
      ? null
      : (tNaa.name === "NAA" || tCr.name === "Cr")
        ? `${tNaa.name}/${tCr.name}`
        : "tNAA/tCr";
    const lwHz = w.fwhmPpm != null && hzpppm > 0
      ? w.fwhmPpm * hzpppm
      : w.linewidthAfterHz ?? w.fidaLinewidthHz ?? null;
    return { ...w, lwHz, tNaaToTCr, tNaaToTCrBasis };
  });

  // Series linewidth z-scores (within condition if >= 4 windows, else whole run).
  const byCond = new Map();
  for (const w of enriched) {
    const key = w.condition ?? "__all__";
    if (!byCond.has(key)) byCond.set(key, []);
    byCond.get(key).push(w);
  }
  const allLws = enriched.map((w) => w.lwHz).filter(Number.isFinite);
  const allMean = mean(allLws);
  const allSd = sampleSd(allLws);

  const classified = enriched.map((w) => {
    if (w.status !== "fitted") {
      return {
        ...w,
        qc: { status: "FAIL", reasons: [w.error ?? w.status], tNaaToTCr: null, tNaaToTCrBasis: null, lwZ: null },
      };
    }
    const reasons = [];
    let level = 0; // 0 PASS, 1 WARN, 2 FAIL
    if (w.fwhmPpm == null) {
      level = Math.max(level, 1);
      reasons.push("FWHM unavailable");
    } else if (w.fwhmPpm > thresholds.fwhmFailPpm) {
      level = Math.max(level, 2);
      reasons.push(`FWHM ${w.fwhmPpm.toFixed(3)} > ${thresholds.fwhmFailPpm} ppm`);
    } else if (w.fwhmPpm > thresholds.fwhmWarnPpm) {
      level = Math.max(level, 1);
      reasons.push(`FWHM ${w.fwhmPpm.toFixed(3)} > ${thresholds.fwhmWarnPpm} ppm`);
    }
    if (w.lcmSnr == null) {
      level = Math.max(level, 1);
      reasons.push("S/N unavailable");
    } else if (w.lcmSnr < thresholds.snrFail) {
      level = Math.max(level, 2);
      reasons.push(`S/N ${w.lcmSnr} < ${thresholds.snrFail}`);
    } else if (w.lcmSnr < thresholds.snrWarn) {
      level = Math.max(level, 1);
      reasons.push(`S/N ${w.lcmSnr} < ${thresholds.snrWarn}`);
    }
    if (w.shiftPpm != null && Math.abs(w.shiftPpm) > thresholds.shiftWarnPpm) {
      level = Math.max(level, 1);
      reasons.push(`|shift| ${Math.abs(w.shiftPpm).toFixed(3)} > ${thresholds.shiftWarnPpm} ppm`);
    }
    if (w.phase0Deg != null && Math.abs(w.phase0Deg) > thresholds.ph0WarnDeg) {
      level = Math.max(level, 1);
      reasons.push(`ph0 ${w.phase0Deg.toFixed(0)} deg`);
    }
    if (w.phase1DegPerPpm != null && Math.abs(w.phase1DegPerPpm) > thresholds.ph1WarnDegPerPpm) {
      level = Math.max(level, 1);
      reasons.push(`ph1 ${w.phase1DegPerPpm.toFixed(1)} deg/ppm`);
    }
    const group = byCond.get(w.condition ?? "__all__") ?? [];
    const groupLws = group.map((g) => g.lwHz).filter(Number.isFinite);
    const refMean = groupLws.length >= 4 ? mean(groupLws) : allMean;
    const refSd = groupLws.length >= 4 ? sampleSd(groupLws) : allSd;
    const lwZ = w.lwHz != null && refMean != null && refSd != null && refSd > 1e-6 ? (w.lwHz - refMean) / refSd : null;
    if (lwZ != null && Math.abs(lwZ) > thresholds.outlierZ) {
      level = Math.max(level, 1);
      reasons.push(`linewidth outlier (z=${lwZ.toFixed(1)})`);
    }
    const status = level === 2 ? "FAIL" : level === 1 ? "WARN" : "PASS";
    return { ...w, qc: { status, reasons, tNaaToTCr: w.tNaaToTCr, tNaaToTCrBasis: w.tNaaToTCrBasis, lwZ } };
  });

  const condNames = [...new Set(classified.map((w) => w.condition ?? "All"))];
  const refCond = baselineCondition ?? chooseBaselineCondition(condNames);
  const condSummaries = condNames.map((cond) => {
    const rows = classified.filter((w) => (w.condition ?? "All") === cond);
    return {
      condition: cond,
      n: rows.length,
      pass: rows.filter((r) => r.qc.status === "PASS").length,
      warn: rows.filter((r) => r.qc.status === "WARN").length,
      fail: rows.filter((r) => r.qc.status === "FAIL").length,
      medianLwHz: median(rows.map((r) => r.lwHz)),
      medianSnr: median(rows.map((r) => r.lcmSnr)),
      medianTNaaToTCr: median(rows.map((r) => r.qc.tNaaToTCr)),
    };
  });
  const refLw = condSummaries.find((c) => c.condition === refCond)?.medianLwHz ?? null;
  for (const c of condSummaries) {
    c.deltaLwVsRefHz = c.medianLwHz != null && refLw != null ? c.medianLwHz - refLw : null;
  }
  return { windows: classified, conditionSummary: condSummaries, baselineCondition: refCond };
}

// ---------------------------------------------------------------------------
// Windowed temporal GLM & condition contrasts
// ---------------------------------------------------------------------------

function windowsOverlap(windows) {
  const seen = new Set();
  for (const w of windows) {
    const idxs = w.keptIndices ?? w.indices;
    if (!Array.isArray(idxs) || !idxs.length) continue;
    for (const idx of idxs) {
      if (seen.has(idx)) return true;
      seen.add(idx);
    }
  }
  return false;
}

/**
 * Summarize metabolite concentrations across conditions and run a temporal
 * OLS GLM (`y = intercept + condition + drift + linewidth`) per metabolite.
 *
 * Excludes `qc.status === "FAIL"` windows by default, suppresses parametric
 * inference on overlapping sliding windows (which violate independence), and
 * marks contrasts non-estimable rather than dropping a collinear linewidth
 * confound.
 */
export function analyzeFmrsWindows(
  windows,
  {
    baselineCondition = null,
    valueKey = "concentration",
    includeDrift = true,
    includeLinewidth = true,
    excludeFailedQc = true,
  } = {},
) {
  const fittedAll = windows.filter((w) => w.status === "fitted");
  const fitted = excludeFailedQc
    ? fittedAll.filter((w) => w.qc?.status !== "FAIL")
    : fittedAll;
  const nExcludedQc = fittedAll.length - fitted.length;
  const overlappingWindows = windowsOverlap(fitted);
  const names = metaboliteNames(fitted);
  const conditions = [...new Set(fitted.map((w) => w.condition).filter(Boolean))];
  const baseline = baselineCondition && conditions.includes(baselineCondition)
    ? baselineCondition
    : chooseBaselineCondition(conditions);
  const nonBase = conditions.filter((c) => c !== baseline);

  const results = [];
  for (const name of names) {
    const obs = fitted
      .map((w) => {
        const m = w.metabolites.find((r) => r.name === name);
        const y = m?.[valueKey];
        if (!Number.isFinite(y)) return null;
        return {
          y,
          sdPercent: m.sdPercent,
          t: w.midTimeS ?? 0,
          lw: w.lwHz ?? w.linewidthAfterHz ?? w.fidaLinewidthHz ?? null,
          condition: w.condition ?? "All",
        };
      })
      .filter(Boolean);

    if (!obs.length) continue;

    // Per-condition descriptive stats
    const byCondition = {};
    for (const cond of conditions.length ? conditions : ["All"]) {
      const sub = obs.filter((o) => o.condition === cond);
      byCondition[cond] = {
        n: sub.length,
        mean: mean(sub.map((o) => o.y)),
        median: median(sub.map((o) => o.y)),
        sd: sampleSd(sub.map((o) => o.y)),
        meanSdPercent: mean(sub.map((o) => o.sdPercent)),
      };
    }

    const contrasts = [];
    if (baseline && nonBase.length) {
      const baseMean = byCondition[baseline]?.mean;
      // Complete-case linewidth policy: if includeLinewidth is requested and
      // some windows have finite linewidth while others are missing, exclude
      // missing-linewidth windows rather than silently dropping the linewidth
      // confound from the model.
      const anyFiniteLw = obs.some((o) => Number.isFinite(o.lw));
      const obsGlm = includeLinewidth && anyFiniteLw
        ? obs.filter((o) => Number.isFinite(o.lw))
        : obs;
      const nExcludedMissingLw = obs.length - obsGlm.length;

      const tMean = mean(obsGlm.map((o) => o.t)) ?? 0;
      const tScale = Math.max(1, ...obsGlm.map((o) => Math.abs(o.t - tMean)));
      const driftVaries = obsGlm.some((o) => Math.abs(o.t - tMean) > 1e-6);
      const lws = obsGlm.map((o) => o.lw);
      const lwMean = anyFiniteLw && obsGlm.length ? mean(lws) : null;
      const lwSd = anyFiniteLw && obsGlm.length >= 2 ? sampleSd(lws) : null;
      const lwVaries = lwMean != null && lwSd != null && lwSd > 1e-3;

      const useDrift = Boolean(includeDrift && driftVaries);
      const useLw = Boolean(includeLinewidth && lwVaries);

      const covariates = [];
      if (useDrift) covariates.push("drift");
      if (useLw) covariates.push("linewidth");

      const X = obsGlm.map((o) => {
        const row = [1];
        for (const c of nonBase) row.push(o.condition === c ? 1 : 0);
        if (useDrift) row.push((o.t - tMean) / tScale);
        if (useLw) row.push((o.lw - lwMean) / lwSd);
        return row;
      });
      const yVec = obsGlm.map((o) => o.y);
      const tVec = obsGlm.map((o) => o.t);

      let ols = null;
      let remlFitted = false;
      let nonEstimableReason = null;
      if (obsGlm.length <= (X[0]?.length ?? 0) || obsGlm.length === 0) {
        nonEstimableReason = obsGlm.length <= nonBase.length + 1
          ? "Insufficient windows for parametric inference."
          : `Insufficient windows (${obsGlm.length}) for model with ${covariates.join(" + ")} covariates.`;
      } else {
        const fit = fitOls(X, yVec);
        if (!fit || fit.rankDeficient) {
          if (useLw) {
            nonEstimableReason = "Condition is collinear with linewidth; linewidth-adjusted contrast is not estimable.";
          } else if (useDrift) {
            nonEstimableReason = "Condition is collinear with linear time drift; drift-adjusted contrast is not estimable.";
          } else {
            nonEstimableReason = "Design matrix is rank-deficient.";
          }
        } else {
          // Check near-exact collinearity of linewidth with condition/drift (R^2 > 0.999)
          let lwCollinear = false;
          if (useLw) {
            const XnoLw = X.map((row) => row.slice(0, -1));
            const lwVec = X.map((row) => row.at(-1));
            const aux = fitOls(XnoLw, lwVec);
            if (aux && !aux.rankDeficient) {
              const ssTot = lwVec.reduce((s, v) => s + v * v, 0);
              const r2 = ssTot > 0 ? 1 - aux.rss / ssTot : 1;
              if (r2 > 0.999) lwCollinear = true;
            }
          }
          if (lwCollinear) {
            nonEstimableReason = "Condition is collinear with linewidth; linewidth-adjusted contrast is not estimable.";
          } else if (obsGlm.length >= 8 && obsGlm.length >= X[0].length + 2) {
            const gls = fitRemlAr1(X, yVec, tVec);
            if (gls && !gls.rankDeficient && gls.zeroResidualVariance) {
              ols = gls;
              nonEstimableReason = "Residual variance is numerically zero; parametric inference suppressed.";
            } else if (gls && !gls.rankDeficient && gls.df >= 1) {
              ols = gls;
              remlFitted = true;
            } else {
              // Never silently fall back to OLS p-values when REML AR(1) cannot fit.
              ols = fit;
              nonEstimableReason = "AR(1) REML model could not be estimated; parametric inference suppressed.";
            }
          } else {
            ols = fit;
            nonEstimableReason = obsGlm.length < 8
              ? `Too few windows (${obsGlm.length}) for autocorrelation-robust inference (minimum 8).`
              : `Insufficient residual degrees of freedom (${obsGlm.length} windows, ${X[0].length} predictors) for AR(1) REML inference.`;
          }
        }
      }

      const glmCounts = new Map();
      for (const o of obsGlm) glmCounts.set(o.condition, (glmCounts.get(o.condition) ?? 0) + 1);
      const nBaseGlm = glmCounts.get(baseline) ?? 0;

      nonBase.forEach((cond, idx) => {
        const condStats = byCondition[cond];
        const baseStats = byCondition[baseline];
        const nCondGlm = glmCounts.get(cond) ?? 0;
        const diff = condStats?.mean != null && baseMean != null ? condStats.mean - baseMean : null;
        const unadjustedPercentChange = diff != null && baseMean != null && Math.abs(baseMean) > 1e-12
          ? (diff / baseMean) * 100
          : null;

        if (!ols) {
          contrasts.push({
            condition: cond,
            baseline,
            estimable: false,
            reason: nonEstimableReason,
            beta: null,
            se: null,
            tStat: null,
            pValue: null,
            df: null,
            percentChange: null,
            unadjustedDiff: diff,
            unadjustedPercentChange,
            nCondition: condStats?.n ?? 0,
            nBaseline: baseStats?.n ?? 0,
            nExcludedMissingLw,
            covariates,
          });
          return;
        }

        const beta = ols.beta[1 + idx];
        const denom = ols.beta[0];
        const percentChange = beta != null && denom != null && Math.abs(denom) > 1e-12 ? (beta / denom) * 100 : null;
        const sparseSideReason = nCondGlm < 2
          ? `Only ${nCondGlm} window in "${cond}"; at least 2 windows per condition are required for parametric inference.`
          : nBaseGlm < 2
            ? `Only ${nBaseGlm} window in baseline "${baseline}"; at least 2 windows per condition are required for parametric inference.`
            : null;
        if (overlappingWindows || !remlFitted || sparseSideReason) {
          contrasts.push({
            condition: cond,
            baseline,
            estimable: false,
            reason: overlappingWindows
              ? "Overlapping windows share transients; parametric inference suppressed."
              : !remlFitted
                ? nonEstimableReason
                : sparseSideReason,
            beta,
            se: null,
            tStat: null,
            pValue: null,
            df: null,
            percentChange,
            unadjustedDiff: diff,
            unadjustedPercentChange,
            nCondition: condStats?.n ?? 0,
            nBaseline: baseStats?.n ?? 0,
            nExcludedMissingLw,
            covariates,
          });
          return;
        }
        const se = ols.se[1 + idx];
        const tStat = beta != null && se != null && se > 0 ? beta / se : null;
        const pValue = tStat != null ? studentTwoTailedP(tStat, ols.df) : null;
        contrasts.push({
          condition: cond,
          baseline,
          estimable: true,
          reason: null,
          beta,
          se,
          tStat,
          pValue,
          df: ols.df,
          ar1Rho: ols.ar1Rho,
          percentChange,
          unadjustedDiff: diff,
          unadjustedPercentChange,
          nCondition: condStats?.n ?? 0,
          nBaseline: baseStats?.n ?? 0,
          nExcludedMissingLw,
          covariates,
        });
      });
    } else if (obs.length >= 4) {
      // No conditions: fit linear time slope across windows using the same
      // complete-case linewidth policy, collinearity guard, and CAR(1) REML GLS.
      const anyFiniteLw = obs.some((o) => Number.isFinite(o.lw));
      const obsGlm = includeLinewidth && anyFiniteLw
        ? obs.filter((o) => Number.isFinite(o.lw))
        : obs;
      const nExcludedMissingLw = obs.length - obsGlm.length;
      const tMean = mean(obsGlm.map((o) => o.t)) ?? 0;
      const tScale = Math.max(1, ...obsGlm.map((o) => Math.abs(o.t - tMean)));
      const lws = obsGlm.map((o) => o.lw);
      const lwMean = anyFiniteLw && obsGlm.length ? mean(lws) : null;
      const lwSd = anyFiniteLw && obsGlm.length >= 2 ? sampleSd(lws) : null;
      const useLw = Boolean(includeLinewidth && lwMean != null && lwSd != null && lwSd > 1e-3);
      const covariates = useLw ? ["time", "linewidth"] : ["time"];
      const X = obsGlm.map((o) => (useLw ? [1, (o.t - tMean) / tScale, (o.lw - lwMean) / lwSd] : [1, (o.t - tMean) / tScale]));
      const yVec = obsGlm.map((o) => o.y);
      const tVec = obsGlm.map((o) => o.t);

      let trendModel = null;
      let trendReml = false;
      let trendReason = null;
      if (obsGlm.length <= (X[0]?.length ?? 0) || obsGlm.length === 0) {
        trendReason = `Insufficient windows (${obsGlm.length}) for trend model with ${covariates.join(" + ")}.`;
      } else {
        const fit = fitOls(X, yVec);
        if (!fit || fit.rankDeficient) {
          trendReason = useLw
            ? "Time trend is collinear with linewidth; linewidth-adjusted trend is not estimable."
            : "Design matrix is rank-deficient.";
        } else {
          let lwCollinear = false;
          if (useLw) {
            const XnoLw = X.map((row) => row.slice(0, -1));
            const lwVec = X.map((row) => row.at(-1));
            const aux = fitOls(XnoLw, lwVec);
            if (aux && !aux.rankDeficient) {
              const ssTot = lwVec.reduce((s, v) => s + v * v, 0);
              const r2 = ssTot > 0 ? 1 - aux.rss / ssTot : 1;
              if (r2 > 0.999) lwCollinear = true;
            }
          }
          if (lwCollinear) {
            trendReason = "Time trend is collinear with linewidth; linewidth-adjusted trend is not estimable.";
          } else if (obsGlm.length >= 8 && obsGlm.length >= X[0].length + 2) {
            const gls = fitRemlAr1(X, yVec, tVec);
            if (gls && !gls.rankDeficient && gls.zeroResidualVariance) {
              trendModel = gls;
              trendReason = "Residual variance is numerically zero; parametric inference suppressed.";
            } else if (gls && !gls.rankDeficient && gls.df >= 1) {
              trendModel = gls;
              trendReml = true;
            } else {
              trendModel = fit;
              trendReason = "AR(1) REML model could not be estimated; parametric inference suppressed.";
            }
          } else {
            trendModel = fit;
            trendReason = obsGlm.length < 8
              ? `Too few windows (${obsGlm.length}) for autocorrelation-robust inference (minimum 8).`
              : `Insufficient residual degrees of freedom (${obsGlm.length} windows, ${X[0].length} predictors) for AR(1) REML inference.`;
          }
        }
      }

      if (!trendModel) {
        contrasts.push({
          condition: "Linear trend (/min)",
          baseline: "Intercept",
          estimable: false,
          reason: trendReason,
          beta: null,
          se: null,
          tStat: null,
          pValue: null,
          df: null,
          percentChange: null,
          nCondition: obsGlm.length,
          nBaseline: obsGlm.length,
          nExcludedMissingLw,
          covariates,
        });
      } else {
        const betaPerMin = (trendModel.beta[1] / tScale) * 60;
        const suppress = overlappingWindows || !trendReml;
        const sePerMin = suppress ? null : (trendModel.se[1] / tScale) * 60;
        const tStat = sePerMin != null && sePerMin > 0 ? betaPerMin / sePerMin : null;
        const pValue = tStat != null ? studentTwoTailedP(tStat, trendModel.df) : null;
        contrasts.push({
          condition: "Linear trend (/min)",
          baseline: "Intercept",
          estimable: !suppress,
          reason: overlappingWindows
            ? "Overlapping windows share transients; parametric inference suppressed."
            : suppress
              ? trendReason
              : null,
          beta: betaPerMin,
          se: sePerMin,
          tStat,
          pValue,
          df: suppress ? null : trendModel.df,
          ar1Rho: suppress ? undefined : trendModel.ar1Rho,
          percentChange: Math.abs(trendModel.beta[0]) > 1e-12 ? (betaPerMin / trendModel.beta[0]) * 100 : null,
          nCondition: obsGlm.length,
          nBaseline: obsGlm.length,
          nExcludedMissingLw,
          covariates,
        });
      }
    }

    results.push({ name, byCondition, contrasts });
  }

  return {
    baseline,
    conditions,
    valueKey,
    seMethod: "reml-ar1-gls",
    nIncluded: fitted.length,
    nExcludedQc,
    overlappingWindows,
    metabolites: results,
  };
}

// ---------------------------------------------------------------------------
// Two-stage Fixed-Template Dynamic Spectral Projection (all kept transients)
// ---------------------------------------------------------------------------

function interpOnGrid(srcX, srcY, targetX) {
  if (!srcX.length || !srcY.length) return targetX.map(() => 0);
  const desc = srcX.length > 1 && srcX[0] > srcX[srcX.length - 1];
  const xs = desc ? [...srcX].reverse() : srcX;
  const ys = desc ? [...srcY].reverse() : srcY;
  const n = xs.length;
  return targetX.map((tx) => {
    if (tx <= xs[0]) return ys[0];
    if (tx >= xs[n - 1]) return ys[n - 1];
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= tx) lo = mid;
      else hi = mid;
    }
    const span = xs[hi] - xs[lo];
    const w = span > 0 ? (tx - xs[lo]) / span : 0;
    return ys[lo] * (1 - w) + ys[hi] * w;
  });
}

/**
 * Two-stage fixed-template dynamic spectral GLM across all kept transients,
 * inspired by Clarke et al. (2024).
 *
 * Stage 1 (LCModel grand-mean fit) supplies unit-scaled metabolite templates
 * and static baseline on the exact `.COORD` ppm grid (automatically masking
 * `PPMGAP` exclusions). Complex per-transient spectra and first-order spectral
 * derivatives (`dS/dLB_Hz`, `dS/df_Hz`) are aligned to `.COORD` using LCModel's
 * chemical-shift (`shiftPpm`), first-order phase (`phase1DegPerPpm`), and a
 * least-squares complex factor `a + i*b` (matching `fillGaps` in `lcmodel-io.js`),
 * verified by relative alignment RMS (`<= 0.25`).
 *
 * Stage 2 projects each kept transient onto the unit-norm-scaled spectral
 * basis (tiny scale-invariant ridge `1e-8`) and fits a temporal GLM with
 * Newey-West HAC standard errors across the `T` serial transients. Note that
 * standard errors are conditional on the fixed grand-mean spectral templates.
 */
export function fitDynamicSpectralGlm({
  dynamic,
  grandCoord,
  events = [],
  trS = 1,
  baselineCondition = null,
  alignmentTolerance = 0.25,
}) {
  const hasComplex = Boolean(dynamic?.spectraRe?.length && dynamic?.spectraIm?.length && dynamic?.meanRe?.length && dynamic?.meanIm?.length);
  const hasLegacy = Boolean(dynamic?.spectra?.length && dynamic?.meanSpectrum?.length);
  if ((!hasComplex && !hasLegacy) || !dynamic?.ppm?.length || !grandCoord?.ppm?.length || !grandCoord?.metabolites?.length) {
    return null;
  }

  const spectraRe = hasComplex ? dynamic.spectraRe : dynamic.spectra;
  const spectraIm = hasComplex ? dynamic.spectraIm : dynamic.spectra.map((row) => new Array(row.length).fill(0));
  const meanRe = hasComplex ? dynamic.meanRe : dynamic.meanSpectrum;
  const meanIm = hasComplex ? dynamic.meanIm : new Array(dynamic.meanSpectrum.length).fill(0);
  const boldDerivRe = hasComplex ? (dynamic.boldDerivRe ?? []) : (dynamic.boldLinewidthDeriv ?? []);
  const boldDerivIm = hasComplex ? (dynamic.boldDerivIm ?? []) : new Array(boldDerivRe.length).fill(0);
  const freqDerivRe = hasComplex ? (dynamic.freqDerivRe ?? []) : (dynamic.freqShiftDeriv ?? []);
  const freqDerivIm = hasComplex ? (dynamic.freqDerivIm ?? []) : new Array(freqDerivRe.length).fill(0);

  const T = spectraRe.length;
  if (T < 4) return null;

  const shiftPpm = Number.isFinite(grandCoord.summary?.shiftPpm) ? grandCoord.summary.shiftPpm : 0;
  const degPerPpm = Number.isFinite(grandCoord.summary?.phase1DegPerPpm) ? grandCoord.summary.phase1DegPerPpm : 0;

  const dynMin = Math.min(...dynamic.ppm);
  const dynMax = Math.max(...dynamic.ppm);
  // Work directly on grandCoord.ppm so .COORD PPMGAP windows are excluded automatically
  // and LCModel's curves require zero interpolation.
  const coordKeep = [];
  for (let i = 0; i < grandCoord.ppm.length; i += 1) {
    const pFida = grandCoord.ppm[i] - shiftPpm;
    if (pFida >= dynMin - 1e-6 && pFida <= dynMax + 1e-6) coordKeep.push(i);
  }
  const F = coordKeep.length;
  if (F < 16) return null;

  const coordPpm = coordKeep.map((i) => grandCoord.ppm[i]);
  const fidaPpm = coordPpm.map((p) => p - shiftPpm);
  const coordData = coordKeep.map((i) => grandCoord.data[i]);
  const cosPh1 = coordPpm.map((p) => Math.cos((degPerPpm * p * Math.PI) / 180));
  const sinPh1 = coordPpm.map((p) => Math.sin((degPerPpm * p * Math.PI) / 180));

  const interpPhasedComplex = (reArr, imArr) => {
    const r = interpOnGrid(dynamic.ppm, reArr, fidaPpm);
    const im = interpOnGrid(dynamic.ppm, imArr, fidaPpm);
    const u = new Array(F);
    const v = new Array(F);
    for (let i = 0; i < F; i += 1) {
      u[i] = r[i] * cosPh1[i] - im[i] * sinPh1[i];
      v[i] = r[i] * sinPh1[i] + im[i] * cosPh1[i];
    }
    return [u, v];
  };

  // Fit complex scalar a + i*b so coordData ≈ a*u - b*v (exact fillGaps convention).
  const [meanU, meanV] = interpPhasedComplex(meanRe, meanIm);
  let uu = 0;
  let uv = 0;
  let vv = 0;
  let ud = 0;
  let vd = 0;
  for (let i = 0; i < F; i += 1) {
    const u = meanU[i];
    const v = meanV[i];
    const d = coordData[i];
    uu += u * u;
    uv += u * v;
    vv += v * v;
    ud += u * d;
    vd += v * d;
  }
  let a = 0;
  let b = 0;
  const det = uu * vv - uv * uv;
  if (Math.abs(det) > 1e-24 * Math.max(1, uu * vv)) {
    a = (ud * vv - vd * uv) / det;
    b = (ud * uv - vd * uu) / det;
  } else if (uu > 1e-24) {
    a = ud / uu;
  } else if (vv > 1e-24) {
    b = -vd / vv;
  } else {
    return null;
  }

  let miss = 0;
  let total = 0;
  for (let i = 0; i < F; i += 1) {
    const pred = a * meanU[i] - b * meanV[i];
    const d = coordData[i];
    miss += (pred - d) ** 2;
    total += d * d;
  }
  const alignmentRms = total > 0 ? Math.sqrt(miss / total) : Number.POSITIVE_INFINITY;

  // Temporal design preparation (even if alignment fails, return condition metadata).
  const times = dynamic.timesS;
  const hasEvents = Array.isArray(events) && events.length > 0;
  const condPerT = hasEvents
    ? times.map((ts) => conditionForInterval(events, ts, ts + trS, "Rest"))
    : times.map(() => "All");
  const conditions = [...new Set(condPerT)];
  const baseline = baselineCondition && conditions.includes(baselineCondition)
    ? baselineCondition
    : chooseBaselineCondition(conditions);
  const nonBase = hasEvents ? conditions.filter((c) => c !== baseline) : [];

  if (!Number.isFinite(alignmentRms) || alignmentRms > alignmentTolerance) {
    return {
      aligned: false,
      alignmentRms: Number.isFinite(alignmentRms) ? alignmentRms : null,
      error: `Complex transient spectra did not align to LCModel's grand-mean .COORD data (relative RMS ${Number.isFinite(alignmentRms) ? alignmentRms.toFixed(3) : "∞"} > ${alignmentTolerance}); dynamic contrasts suppressed.`,
      transientsUsed: T,
      frequencyPoints: F,
      degreesOfFreedom: null,
      conditions,
      baseline,
      covariates: [],
      eccApplied: Boolean(dynamic.eccApplied),
      metabolites: [],
      boldLinewidth: null,
      freqShift: null,
    };
  }

  const projectReal = (reArr, imArr) => {
    const [u, v] = interpPhasedComplex(reArr, imArr);
    const out = new Array(F);
    for (let i = 0; i < F; i += 1) out[i] = a * u[i] - b * v[i];
    return out;
  };

  // Build spectral basis columns (F x K) directly on coordKeep.
  const cols = [];
  const meta = [];
  const bg = grandCoord.background ?? [];
  for (const m of grandCoord.metabolites) {
    if (!(m.concentration > 0) || !m.curve?.length) continue;
    const pure = coordKeep.map((idx) => (m.curve[idx] - (bg[idx] ?? 0)) / m.concentration);
    const energy = pure.reduce((s, v) => s + v * v, 0);
    if (!(energy > 1e-18)) continue;
    cols.push(pure);
    meta.push({ kind: "metabolite", name: m.name, grandConc: m.concentration });
  }
  if (!cols.length) return null;

  const bgCol = coordKeep.map((idx) => bg[idx] ?? 0);
  if (bgCol.some((v) => Math.abs(v) > 1e-12)) {
    cols.push(bgCol);
    meta.push({ kind: "baseline", name: "Baseline", grandConc: 1 });
  }

  if (boldDerivRe.length === dynamic.ppm.length) {
    const boldCol = projectReal(boldDerivRe, boldDerivIm);
    if (boldCol.some((v) => Math.abs(v) > 1e-12)) {
      cols.push(boldCol);
      meta.push({ kind: "bold", name: "BOLD_Linewidth_Hz", grandConc: 0 });
    }
  }

  if (freqDerivRe.length === dynamic.ppm.length) {
    const freqCol = projectReal(freqDerivRe, freqDerivIm);
    if (freqCol.some((v) => Math.abs(v) > 1e-12)) {
      cols.push(freqCol);
      meta.push({ kind: "freq", name: "Freq_Shift_Hz", grandConc: 0 });
    }
  }

  const K = cols.length;
  // Unit L2 column normalization so ridge is strictly scale-invariant across
  // metabolites, baseline, BOLD linewidth derivative, and frequency derivative.
  const colNorms = cols.map((col) => Math.sqrt(col.reduce((s, v) => s + v * v, 0)));
  const normCols = cols.map((col, k) => col.map((v) => v / colNorms[k]));

  const MtM = Array.from({ length: K }, () => new Array(K).fill(0));
  for (let i = 0; i < K; i += 1) {
    for (let j = i; j < K; j += 1) {
      let s = 0;
      const ci = normCols[i];
      const cj = normCols[j];
      for (let f = 0; f < F; f += 1) s += ci[f] * cj[f];
      MtM[i][j] = s;
      MtM[j][i] = s;
    }
  }
  // Check unregularized spectral rank via Householder QR before adding ridge
  // so rank-deficient / indistinguishable templates are never silently given
  // significant component-level p-values.
  const spectralMatrix = Array.from({ length: F }, (_, f) => Array.from({ length: K }, (_, k) => normCols[k][f]));
  const spectralCheck = fitOls(spectralMatrix, new Array(F).fill(0));
  const spectralFullRank = Boolean(spectralCheck && !spectralCheck.rankDeficient);

  const ridge = 1e-8;
  for (let i = 0; i < K; i += 1) MtM[i][i] += ridge;
  const MtMinv = invertMatrix(MtM);
  if (!MtMinv) return null;
  const spectralVifs = MtMinv.map((row, k) => row[k]);
  const maxSpectralVif = Math.max(...spectralVifs);
  const MAX_SPECTRAL_VIF = 1000;
  const identifiable = spectralFullRank && maxSpectralVif <= MAX_SPECTRAL_VIF;

  // Project each aligned kept transient -> C[k][t] (rescaled to physical units).
  const C = Array.from({ length: K }, () => new Array(T).fill(0));
  for (let t = 0; t < T; t += 1) {
    const ySpec = projectReal(spectraRe[t], spectraIm[t]);
    const Mty = new Array(K).fill(0);
    for (let i = 0; i < K; i += 1) {
      let s = 0;
      const ci = normCols[i];
      for (let f = 0; f < F; f += 1) s += ci[f] * ySpec[f];
      Mty[i] = s;
    }
    for (let i = 0; i < K; i += 1) {
      let s = 0;
      for (let j = 0; j < K; j += 1) s += MtMinv[i][j] * Mty[j];
      C[i][t] = s / colNorms[i];
    }
  }

  // Build temporal design matrix X (T x R) and fit with Newey-West HAC SEs.
  const tMean = mean(times) ?? 0;
  const tScale = Math.max(1, ...times.map((ts) => Math.abs(ts - tMean)));
  const includeDrift = T >= nonBase.length + 3 && times.some((ts) => Math.abs(ts - tMean) > 1e-6);

  const X = times.map((ts, idx) => {
    const row = [1];
    for (const c of nonBase) row.push(condPerT[idx] === c ? 1 : 0);
    if (includeDrift) row.push((ts - tMean) / tScale);
    return row;
  });

  const condCounts = new Map();
  for (const c of condPerT) condCounts.set(c, (condCounts.get(c) ?? 0) + 1);
  const nBaseline = condCounts.get(baseline) ?? 0;

  const metabolites = [];
  let boldLinewidth = null;
  let freqShift = null;
  let df = null;
  let hacLag = 0;

  for (let k = 0; k < K; k += 1) {
    const info = meta[k];
    if (info.kind === "baseline") continue;
    const vif = spectralVifs[k];
    const componentIdentifiable = vif <= MAX_SPECTRAL_VIF;
    const ols = fitOls(X, C[k], { hac: true });
    if (!ols || ols.rankDeficient) continue;
    df = ols.df;
    hacLag = ols.hacLag;
    const contrasts = [];
    const unidentifiableReason = `Spectral template is collinear with other templates (VIF ${vif >= 1e5 ? vif.toExponential(1) : vif.toFixed(0)} > ${MAX_SPECTRAL_VIF}); component-level inference suppressed.`;
    if (nonBase.length) {
      nonBase.forEach((cond, idx) => {
        const nCondition = condCounts.get(cond) ?? 0;
        if (!componentIdentifiable) {
          contrasts.push({
            condition: cond,
            baseline,
            estimable: false,
            reason: unidentifiableReason,
            beta: null,
            se: null,
            tStat: null,
            pValue: null,
            df: null,
            percentChange: null,
            nCondition,
            nBaseline,
          });
          return;
        }
        const beta = ols.beta[1 + idx];
        const percentChange = info.kind === "metabolite" && info.grandConc > 0 ? (beta / info.grandConc) * 100 : null;
        if (nCondition < 2 || nBaseline < 2) {
          contrasts.push({
            condition: cond,
            baseline,
            estimable: false,
            reason: nCondition < 2
              ? `Only ${nCondition} kept transient in "${cond}"; at least 2 transients per condition are required for parametric inference.`
              : `Only ${nBaseline} kept transient in baseline "${baseline}"; at least 2 transients per condition are required for parametric inference.`,
            beta,
            se: null,
            tStat: null,
            pValue: null,
            df: null,
            percentChange,
            nCondition,
            nBaseline,
          });
          return;
        }
        if (ols.zeroResidualVariance) {
          contrasts.push({
            condition: cond,
            baseline,
            estimable: false,
            reason: "Residual variance is numerically zero; parametric inference suppressed.",
            beta,
            se: null,
            tStat: null,
            pValue: null,
            df: null,
            percentChange,
            nCondition,
            nBaseline,
          });
          return;
        }
        const se = ols.se[1 + idx];
        const tStat = se > 0 ? beta / se : null;
        const pValue = tStat != null ? studentTwoTailedP(tStat, ols.df) : null;
        contrasts.push({ condition: cond, baseline, estimable: true, reason: null, beta, se, tStat, pValue, df: ols.df, percentChange, nCondition, nBaseline });
      });
    } else if (includeDrift) {
      if (!componentIdentifiable) {
        contrasts.push({
          condition: "Linear trend (/min)",
          baseline: "Intercept",
          estimable: false,
          reason: unidentifiableReason,
          beta: null,
          se: null,
          tStat: null,
          pValue: null,
          df: null,
          percentChange: null,
        });
      } else {
        const betaPerMin = (ols.beta[1] / tScale) * 60;
        const percentChange = info.kind === "metabolite" && info.grandConc > 0 ? (betaPerMin / info.grandConc) * 100 : null;
        if (ols.zeroResidualVariance) {
          contrasts.push({
            condition: "Linear trend (/min)",
            baseline: "Intercept",
            estimable: false,
            reason: "Residual variance is numerically zero; parametric inference suppressed.",
            beta: betaPerMin,
            se: null,
            tStat: null,
            pValue: null,
            df: null,
            percentChange,
          });
        } else {
          const sePerMin = (ols.se[1] / tScale) * 60;
          const tStat = sePerMin > 0 ? betaPerMin / sePerMin : null;
          const pValue = tStat != null ? studentTwoTailedP(tStat, ols.df) : null;
          contrasts.push({ condition: "Linear trend (/min)", baseline: "Intercept", estimable: true, reason: null, beta: betaPerMin, se: sePerMin, tStat, pValue, df: ols.df, percentChange });
        }
      }
    }

    if (info.kind === "metabolite") {
      metabolites.push({ name: info.name, grandConcentration: info.grandConc, spectralVif: vif, intercept: componentIdentifiable ? ols.beta[0] : null, contrasts });
    } else if (info.kind === "bold") {
      boldLinewidth = { contrasts, spectralVif: vif, series: C[k] };
    } else if (info.kind === "freq") {
      freqShift = { contrasts, spectralVif: vif, series: C[k] };
    }
  }

  return {
    aligned: true,
    identifiable,
    spectralFullRank,
    alignmentRms,
    maxSpectralVif,
    eccApplied: Boolean(dynamic.eccApplied),
    seMethod: "newey-west-hac",
    hacLag,
    transientsUsed: T,
    frequencyPoints: F,
    degreesOfFreedom: df,
    conditions,
    baseline,
    covariates: includeDrift ? ["drift", "bold_linewidth", "freq_shift"] : ["bold_linewidth", "freq_shift"],
    metabolites,
    boldLinewidth,
    freqShift,
  };
}

// ---------------------------------------------------------------------------
// CSV exports & printable HTML report
// ---------------------------------------------------------------------------

function csvCell(value) {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (cells) => cells.map(csvCell).join(",");

const WINDOW_HEADERS = [
  "window", "label", "condition", "start_time_s", "end_time_s", "mid_time_s",
  "averages_total", "averages_kept", "averages_removed",
  "status", "qc_status", "qc_reasons", "error", "basis", "unit", "ratio_to",
  "linewidth_before_hz", "linewidth_after_hz", "broadening_applied_hz", "linewidth_match_status",
  "fwhm_ppm", "lw_hz", "lcmodel_snr", "shift_ppm", "ph0_deg", "ph1_deg_per_ppm", "tnaa_tcr", "tnaa_tcr_basis",
];

function windowCells(w, index) {
  return [
    index + 1,
    w.label,
    w.condition ?? "",
    w.startTimeS,
    w.endTimeS,
    w.midTimeS,
    w.averagesTotal,
    w.averagesKept,
    w.averagesRemoved,
    w.status,
    w.qc?.status ?? "",
    (w.qc?.reasons ?? []).join("; "),
    w.error ?? "",
    w.basis ?? "",
    w.unit ?? "",
    w.ratioTo ?? "",
    w.linewidthBeforeHz,
    w.linewidthAfterHz,
    w.broadeningAppliedHz,
    w.linewidthMatchStatus ?? "",
    w.fwhmPpm,
    w.lwHz,
    w.lcmSnr,
    w.shiftPpm,
    w.phase0Deg,
    w.phase1DegPerPpm,
    w.qc?.tNaaToTCr,
    w.qc?.tNaaToTCrBasis ?? "",
  ];
}

export function fmrsTimeCourseCsvLong(windows) {
  const header = [...WINDOW_HEADERS, "metabolite", "concentration", "sd_percent", "ratio"];
  const lines = [csvLine(header)];
  windows.forEach((w, idx) => {
    const base = windowCells(w, idx);
    if (!w.metabolites?.length) {
      lines.push(csvLine([...base, "", "", "", ""]));
      return;
    }
    for (const m of w.metabolites) {
      lines.push(csvLine([...base, m.name, m.concentration, m.sdPercent, m.ratio]));
    }
  });
  return `${lines.join("\n")}\n`;
}

export function fmrsTimeCourseCsvWide(windows) {
  const names = metaboliteNames(windows);
  const header = [
    ...WINDOW_HEADERS,
    ...names.flatMap((n) => [n, `${n}_sd_percent`, `${n}_ratio`]),
  ];
  const lines = [csvLine(header)];
  windows.forEach((w, idx) => {
    const byName = new Map((w.metabolites ?? []).map((m) => [m.name, m]));
    const vals = names.flatMap((n) => {
      const m = byName.get(n);
      return [m?.concentration, m?.sdPercent, m?.ratio];
    });
    lines.push(csvLine([...windowCells(w, idx), ...vals]));
  });
  return `${lines.join("\n")}\n`;
}

export function fmrsTransientsCsv(transients, events = [], trS = 1) {
  const header = ["transient", "time_s", "condition", "kept", "removed", "metric", "freq_hz", "phase_deg"];
  const lines = [csvLine(header)];
  for (const t of transients ?? []) {
    const cond = events?.length ? conditionForInterval(events, t.timeS, t.timeS + trS, "Rest") : "";
    lines.push(csvLine([t.index + 1, t.timeS, cond, t.kept, t.removed, t.metric, t.freqHz, t.phaseDeg]));
  }
  return `${lines.join("\n")}\n`;
}

export function fmrsStatsCsv({ windowedStats, dynamicGlm }) {
  const header = ["model", "metabolite", "condition", "baseline", "estimable", "beta", "se", "t_stat", "p_value", "df", "percent_change", "unadjusted_diff", "covariates", "note"];
  const lines = [csvLine(header)];
  for (const m of windowedStats?.metabolites ?? []) {
    for (const c of m.contrasts ?? []) {
      lines.push(csvLine([
        "windowed_glm",
        m.name,
        c.condition,
        c.baseline,
        c.estimable !== false,
        c.beta,
        c.se,
        c.tStat,
        c.pValue,
        c.df,
        c.percentChange,
        c.unadjustedDiff ?? "",
        (c.covariates ?? []).join("+"),
        c.reason ?? "",
      ]));
    }
  }
  if (dynamicGlm && dynamicGlm.aligned !== false) {
    const hacNote = `Newey-West HAC (lag ${dynamicGlm.hacLag ?? 0}); SEs conditional on grand-mean templates`;
    const pushDyn = (name, contrasts) => {
      for (const c of contrasts ?? []) {
        lines.push(csvLine([
          "dynamic_projection_glm",
          name,
          c.condition,
          c.baseline,
          c.estimable !== false,
          c.beta,
          c.se,
          c.tStat,
          c.pValue,
          c.df,
          c.percentChange,
          "",
          (dynamicGlm.covariates ?? []).join("+"),
          c.reason ? `${c.reason} ${hacNote}` : hacNote,
        ]));
      }
    };
    for (const m of dynamicGlm.metabolites ?? []) pushDyn(m.name, m.contrasts);
    if (dynamicGlm.boldLinewidth) pushDyn("BOLD_Linewidth_Hz", dynamicGlm.boldLinewidth.contrasts);
    if (dynamicGlm.freqShift) pushDyn("Freq_Shift_Hz", dynamicGlm.freqShift.contrasts);
  }
  return `${lines.join("\n")}\n`;
}

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const fmtP = (p) => (p == null || !Number.isFinite(p) ? "—" : p < 0.0001 ? "<0.0001" : p.toFixed(4));

/** Self-contained printable HTML fMRS QC and analysis report. */
export function buildFmrsReport({
  datasetName,
  generated,
  versions,
  basis,
  mode,
  trS = null,
  matchLinewidth,
  targetLinewidthHz,
  events = [],
  transients = [],
  windows = [],
  conditionSummary = [],
  baselineCondition = null,
  windowedStats = null,
  dynamicGlm = null,
  highlightMetabolite = "Glu",
}) {
  const discreteCategories = mode === "conditions" ? windows.map((w) => w.label) : null;
  const qcSvg = qcTimeCourseSvg({ windows, events: discreteCategories ? [] : events, baselineCondition, categories: discreteCategories });
  const driftSvg = transients.length ? transientDriftSvg({ transients, events, baselineCondition }) : "";
  const available = metaboliteNames(windows);
  const chosenMetab = available.includes(highlightMetabolite) ? highlightMetabolite : available[0];
  const metabSvg = chosenMetab
    ? timeCourseSvg({
        points: windows.map((w, idx) => {
          const m = w.metabolites?.find((r) => r.name === chosenMetab);
          const y = m?.concentration ?? null;
          const err = y != null && m?.sdPercent != null ? (y * m.sdPercent) / 100 : null;
          return {
            x: discreteCategories ? idx : w.midTimeS,
            y,
            err,
            flagged: m && m.sdPercent > SD_LIMIT,
            tip: `${w.label}: ${y != null ? formatConc(y) : "—"} (${m?.sdPercent ?? "?"}%)`,
          };
        }),
        events: discreteCategories ? [] : events,
        baselineCondition,
        categories: discreteCategories,
        xLabel: discreteCategories ? "Condition" : "Time (s)",
        yLabel: `${chosenMetab} (${windows.find((w) => w.unit)?.unit ?? "a.u."})`,
        ariaLabel: `${chosenMetab} concentration time course`,
      })
    : "";

  const condRows = conditionSummary.map((c) => `<tr>
    <td>${escapeHtml(c.condition)}</td>
    <td>${c.n}</td><td>${c.pass}</td><td>${c.warn}</td><td>${c.fail}</td>
    <td>${fmtNum(c.medianLwHz, 2)}</td><td>${fmtNum(c.deltaLwVsRefHz, 2)}</td>
    <td>${fmtNum(c.medianSnr, 1)}</td><td>${fmtNum(c.medianTNaaToTCr, 3)}</td>
  </tr>`).join("");

  const winRows = windows.map((w, k) => `<tr>
    <td>${k + 1}</td>
    <td>${escapeHtml(w.label)}</td>
    <td>${escapeHtml(w.condition ?? "—")}</td>
    <td>${discreteCategories ? "pooled" : fmtNum(w.midTimeS, 1)}</td>
    <td>${w.averagesKept}/${w.averagesTotal}</td>
    <td class="status-${escapeHtml((w.qc?.status ?? "FAIL").toLowerCase())}">${escapeHtml(w.qc?.status ?? w.status)}</td>
    <td>${fmtNum(w.fwhmPpm, 3)}</td>
    <td>${fmtNum(w.lwHz, 1)}</td>
    <td>${fmtNum(w.broadeningAppliedHz, 2)}${w.linewidthMatchStatus && w.linewidthMatchStatus !== "off" ? ` (${escapeHtml(w.linewidthMatchStatus)})` : ""}</td>
    <td>${fmtNum(w.lcmSnr, 0)}</td>
    <td>${fmtNum(w.shiftPpm, 3)}</td>
    <td>${fmtNum(w.phase0Deg, 0)}</td>
    <td>${escapeHtml((w.qc?.reasons ?? []).join("; ") || w.error || "—")}</td>
  </tr>`).join("");

  const statRows = (list, label) => (list ?? []).flatMap((m) =>
    (m.contrasts ?? []).map((c) => `<tr>
      <td>${escapeHtml(label)}</td>
      <td>${escapeHtml(m.name)}</td>
      <td>${escapeHtml(c.condition)} vs ${escapeHtml(c.baseline)}</td>
      <td>${fmtNum(c.beta, 4)}</td>
      <td>${fmtNum(c.se, 4)}</td>
      <td>${c.percentChange == null ? "—" : `${c.percentChange >= 0 ? "+" : ""}${c.percentChange.toFixed(2)}%`}</td>
      <td>${fmtNum(c.tStat, 2)}</td>
      <td>${fmtP(c.pValue)}</td>
      <td>${c.df ?? "—"}</td>
      <td>${escapeHtml(c.reason ?? "")}</td>
    </tr>`),
  ).join("");

  const dynExtra = [];
  if (dynamicGlm?.boldLinewidth) dynExtra.push({ name: "BOLD Linewidth (Hz)", contrasts: dynamicGlm.boldLinewidth.contrasts });
  if (dynamicGlm?.freqShift) dynExtra.push({ name: "Freq Shift (Hz)", contrasts: dynamicGlm.freqShift.contrasts });

  const statsTableRows = statRows(windowedStats?.metabolites, "Windowed GLM")
    + statRows([...(dynamicGlm?.metabolites ?? []), ...dynExtra], "Dynamic projection GLM");

  const statsNotes = [];
  if (windowedStats?.nExcludedQc > 0) statsNotes.push(`${windowedStats.nExcludedQc} QC-FAIL window(s) excluded from windowed GLM.`);
  if (windowedStats?.overlappingWindows) statsNotes.push("Overlapping sliding windows share transients; windowed p-values are suppressed.");
  if (dynamicGlm?.aligned === false) statsNotes.push(dynamicGlm.error);
  else if (dynamicGlm?.aligned) statsNotes.push(`Dynamic projection GLM: ${dynamicGlm.transientsUsed} transients, alignment RMS ${(dynamicGlm.alignmentRms ?? 0).toFixed(3)}, Newey-West HAC SEs (conditional on fixed grand-mean templates).`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>fMRS Report — ${escapeHtml(datasetName)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; color: #1b1f23; background: #fff; max-width: 1080px; margin: 24px auto; padding: 0 20px 40px; font-size: 13px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  h2 { font-size: 15px; margin: 24px 0 8px; border-bottom: 1px solid #e1e4e8; padding-bottom: 4px; }
  .meta { color: #57606a; margin: 0 0 16px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 12px; }
  th, td { border: 1px solid #d0d7de; padding: 4px 7px; text-align: left; }
  th { background: #f6f8fa; font-weight: 600; }
  .status-pass { color: #1a7f37; font-weight: 600; }
  .status-warn { color: #9a6700; font-weight: 600; }
  .status-fail { color: #cf222e; font-weight: 600; }
  .lcm-plot { width: 100%; height: auto; display: block; margin: 10px 0 18px; }
  .lcm-plot text { fill: #57606a; font-size: 11px; }
  .lcm-plot .lcm-label { fill: #1b1f23; font-size: 11px; }
  .lcm-plot .lcm-axis { stroke: #8c959f; }
  .lcm-plot .lcm-grid { stroke: #e5e7eb; stroke-dasharray: 2 4; }
  .lcm-plot .lcm-gap { fill: rgba(70, 125, 37, 0.12); }
  .lcm-plot polyline { fill: none; stroke-linejoin: round; }
  .lcm-plot .lcm-fit { stroke: #467d25; stroke-width: 1.8; }
  .lcm-plot .lcm-reference { stroke: #8c959f; stroke-width: 1.2; stroke-dasharray: 4 3; }
  .lcm-plot .lcm-background { stroke: #8c959f; stroke-width: 1; stroke-dasharray: 4 3; }
  .lcm-plot .lcm-residual { stroke: #6e7781; stroke-width: 1; }
  .lcm-plot .lcm-point-fit { fill: #467d25; }
  .lcm-plot .lcm-point-reference { fill: #8c959f; }
  .lcm-plot .lcm-point-flag { fill: #cf222e; }
</style>
</head>
<body>
  <h1>Functional MRS QC &amp; Quantification Report: ${escapeHtml(datasetName)}</h1>
  <p class="meta">Generated ${escapeHtml(generated)} · ${escapeHtml(versions?.app ?? "")} · Basis: ${escapeHtml(basis?.label ?? "")} · Mode: ${escapeHtml(mode)}${trS != null ? ` · Fixed-TR timing (${fmtNum(trS, 2)} s/transient)` : ""} · BOLD LW matching: ${matchLinewidth ? `on (target ${fmtNum(targetLinewidthHz, 2)} Hz)` : "off"} · ${windows.length} bins</p>
  <h2>By condition</h2>
  <table>
    <thead><tr><th>Condition</th><th>n</th><th>PASS</th><th>WARN</th><th>FAIL</th><th>Median LW (Hz)</th><th>&Delta; LW vs ${escapeHtml(baselineCondition ?? "ref")} (Hz)</th><th>Median S/N</th><th>Median tNAA/tCr</th></tr></thead>
    <tbody>${condRows}</tbody>
  </table>
  ${chosenMetab ? `<h2>Metabolite ${discreteCategories ? "by condition" : "time course"} (${escapeHtml(chosenMetab)})</h2>${metabSvg}` : ""}
  <h2>QC ${discreteCategories ? "by condition" : "time courses"}</h2>
  ${qcSvg}
  ${driftSvg ? `<h2>Per-transient frequency and phase drift</h2>${driftSvg}` : ""}
  ${statsNotes.length ? `<p class="meta">${escapeHtml(statsNotes.join(" "))}</p>` : ""}
  ${statsTableRows ? `<h2>Condition contrasts &amp; temporal GLM</h2><table><thead><tr><th>Model</th><th>Metabolite</th><th>Contrast</th><th>Beta</th><th>SE</th><th>% Change</th><th>t</th><th>p</th><th>df</th><th>Note</th></tr></thead><tbody>${statsTableRows}</tbody></table>` : ""}
  <h2>Window QC table</h2>
  <table>
    <thead><tr><th>#</th><th>Window</th><th>Condition</th><th>Time (s)</th><th>Kept</th><th>QC</th><th>FWHM (ppm)</th><th>LW (Hz)</th><th>LB added (Hz)</th><th>S/N</th><th>Shift</th><th>ph0</th><th>Reasons</th></tr></thead>
    <tbody>${winRows}</tbody>
  </table>
</body>
</html>`;
}
