// transform_log_to_csv.py: per-slice predictions to the BIDS app's tables.
// Python's round(x, 2), float repr and pandas' CSV quoting are reproduced so
// the files match the original byte for byte, except tot_df.csv's `t`, the
// processing time.

export const METHODS = Object.freeze(['percentage', 'mean', 'median']);
export const DEFAULT_METHOD = 'percentage';
export const DEFAULT_AREAS = 3;

/**
 * Python's round(x, 2): the exact binary value, ties to even. A tie needs
 * x * 100 to end in exactly .5, which a double can only hold when x is an odd
 * multiple of 1/8; everywhere else toFixed already rounds the exact value.
 */
export function round2(x) {
  const eighths = x * 8;
  if (Number.isInteger(eighths) && eighths % 2 !== 0) {
    const hundredths = eighths * 12.5;
    const floor = Math.floor(hundredths);
    return (floor % 2 === 0 ? floor : floor + 1) / 100;
  }
  return Number(x.toFixed(2));
}

/**
 * NumPy's round(x, 2) on a float64 scalar, as pandas' mean and median return:
 * rint(x * 100) / 100, ties to even after the multiplication. It differs from
 * round2 where x * 100 rounds onto .5, e.g. 101 / 200 gives 0.5, not 0.51.
 */
export function roundNumpy2(x) {
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  const fraction = scaled - floor;
  const rounded = fraction > 0.5 || (fraction === 0.5 && floor % 2 !== 0) ? floor + 1 : floor;
  return rounded / 100;
}

/** Python repr of a float in [0, 1e16): integers keep their ".0". */
export function pyFloat(x) {
  return Number.isInteger(x) ? `${x}.0` : String(x);
}

const toPred = (proba) => (proba > 0.5 ? 1 : 0);

function mean(values) {
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Per axis and per area: pandas' mean and median are NumPy scalars, the
// percentage a Python float.
function proba(preds, method) {
  if (method === 'mean') return roundNumpy2(mean(preds));
  if (method === 'median') return roundNumpy2(median(preds));
  return round2(preds.filter((p) => p > 0).length / preds.length);
}

/** get_results_locally: the axis cut into bins of floor(max slice / areas) slices. */
function localResults(rows, method, areas) {
  const last = rows[rows.length - 1].slice;
  const n = Math.trunc(last / areas);
  if (!(n > 1)) throw new Error(`Too few slices along an axis for ${areas} areas.`);
  const bins = [];
  const bin = (start, end) => {
    const preds = rows.filter((r) => r.slice >= start && r.slice <= end).map((r) => r.pred);
    const p = proba(preds, method);
    bins.push({ slice_start: start, slice_end: end, proba: p, pred: toPred(p) });
  };
  let i = rows[0].slice - 1;
  while (i + n < last) {
    bin(i + 1, i + n);
    i += n;
  }
  bin(i + 1, last);
  return bins;
}

/**
 * @param {{ axis: 'x' | 'y' | 'z', slice: number, pred: 0 | 1 }[]} predictions
 * @param {{ method?: string, areas?: number }} [options]
 */
export function summarize(predictions, { method = DEFAULT_METHOD, areas = DEFAULT_AREAS } = {}) {
  if (!METHODS.includes(method)) throw new Error(`Unknown method ${method}; use percentage, mean or median.`);
  if (!Number.isInteger(areas) || areas < 1) throw new Error('The number of areas must be a whole number of at least 1.');
  const table = [...predictions].sort((a, b) => (a.axis === b.axis ? a.slice - b.slice : a.axis < b.axis ? -1 : 1));
  const preds = table.map((r) => r.pred);
  let overall;
  if (method === 'percentage') {
    // predict_all_axes.py logs round(share, 2) * 100 percent; the CSV step divides it back.
    overall = round2((round2(preds.filter((p) => p === 1).length / preds.length) * 100) / 100);
  } else {
    // Parsed back from the log as a Python float.
    overall = round2(method === 'mean' ? mean(preds) : median(preds));
  }
  const axes = {};
  for (const axis of ['x', 'y', 'z']) {
    const rows = table.filter((r) => r.axis === axis);
    if (!rows.length) throw new Error(`No ${axis} slices were classified.`);
    const p = proba(rows.map((r) => r.pred), method);
    axes[axis] = { proba: p, pred: toPred(p), areas: localResults(rows, method, areas) };
  }
  const flagged = table.filter((r) => r.pred === 1);
  return {
    method,
    areas,
    table,
    proba: overall,
    pred: toPred(overall),
    flagged: flagged.map(({ axis, slice }) => ({ axis, slice })),
    axes,
  };
}

const field = (text) => (/[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text);
const csv = (header, rows) => [header.join(','), ...rows.map((row) => row.map((v) => field(String(v))).join(','))].join('\n') + '\n';

export function tableCsv(summary) {
  return csv(['pred', 'slice', 'axis'], summary.table.map((r) => [r.pred, r.slice, r.axis]));
}

export function localCsv(summary, axis) {
  return csv(['slice_start', 'slice_end', 'proba', 'pred'], summary.axes[axis].areas.map((b) => [b.slice_start, b.slice_end, pyFloat(b.proba), b.pred]));
}

/** tot_df.csv; `seconds` is the processing time the original logs as `t`. */
export function totCsv(summary, subid, seconds) {
  const { axes } = summary;
  return csv(
    ['subid', 'proba', 't', 'slices', 'axes', 'x_proba', 'y_proba', 'z_proba', 'pred', 'x_pred', 'y_pred', 'z_pred'],
    [[
      subid,
      pyFloat(summary.proba),
      pyFloat(round2(seconds)),
      `[${summary.flagged.map((r) => r.slice).join(', ')}]`,
      `[${summary.flagged.map((r) => `'${r.axis}'`).join(', ')}]`,
      pyFloat(axes.x.proba),
      pyFloat(axes.y.proba),
      pyFloat(axes.z.proba),
      summary.pred,
      axes.x.pred,
      axes.y.pred,
      axes.z.pred,
    ]],
  );
}

/** BIDS subject label from a file name, as run.py names the output (sub-<label>). */
export function subjectId(fileName) {
  const match = /(?:^|[/_])(sub-[A-Za-z0-9]+)/.exec(fileName);
  return match ? match[1] : fileName.replace(/\.nii(\.gz)?$/i, '');
}
