// Group results: one record per dataset of a multi-dataset run, the basis set
// each dataset is fitted with, and the group table as CSV. Pure, Node-tested.

/** A dataset's state in a group run. */
export const STATUS = Object.freeze({
  fitted: "fitted",
  failed: "failed",
  cancelled: "cancelled",
});

/**
 * Per-dataset quality columns, in table order. `key` is the record field,
 * `header` the CSV column and `label` the in-app column title.
 */
export const QC_COLUMNS = Object.freeze([
  { key: "fidaSnr", header: "fida_snr", label: "SNR", title: "FID-A signal-to-noise ratio (NAA)" },
  { key: "fidaLinewidthHz", header: "fida_linewidth_hz", label: "LW (Hz)", title: "FID-A linewidth (NAA, Hz)" },
  { key: "averagesRemoved", header: "averages_removed", label: "Removed", title: "Averages removed by FID-A" },
  { key: "averages", header: "averages", label: "Averages", title: "Averages before removal" },
  { key: "driftHz", header: "fida_drift_hz", label: "Drift (Hz)", title: "FID-A total frequency drift (Hz)" },
  { key: "fwhmPpm", header: "lcmodel_fwhm_ppm", label: "FWHM (ppm)", title: "LCModel linewidth (ppm)" },
  { key: "lcmSnr", header: "lcmodel_snr", label: "S/N", title: "LCModel signal-to-noise ratio" },
  { key: "shiftPpm", header: "lcmodel_shift_ppm", label: "Shift (ppm)", title: "LCModel data shift (ppm)" },
]);

/**
 * Per-metabolite values; a new column (a corrected concentration) is one
 * entry. The tissue-corrected columns are empty for a dataset that was not
 * corrected; `alphaCorrected` is GABA and Glx only (Harris et al. 2015).
 */
export const METABOLITE_FIELDS = Object.freeze([
  { key: "concentration", header: "concentration", suffix: "" },
  { key: "sdPercent", header: "sd_percent", suffix: "_sd_percent" },
  { key: "ratio", header: "ratio", suffix: "_ratio" },
  { key: "tissueCorrected", header: "tissue_corrected_mmol_per_kg", suffix: "_tissue_corrected" },
  { key: "alphaCorrected", header: "alpha_corrected_mmol_per_kg", suffix: "_alpha_corrected" },
]);

/** Per-dataset fit settings and tissue fractions, after the identifying columns. */
export const SETTING_COLUMNS = Object.freeze([
  { key: "macromoleculeModel", header: "macromolecule_model" },
  { key: "lineBroadening", header: "line_broadening" },
  { key: "fractionGM", header: "fraction_gm" },
  { key: "fractionWM", header: "fraction_wm" },
  { key: "fractionCSF", header: "fraction_csf" },
  { key: "fractionSource", header: "fraction_source" },
]);

const DATASET_HEADERS = ["dataset", "file", "status", "error", "format", "basis", "edited", "unit", "ratio_to", ...SETTING_COLUMNS.map((c) => c.header)];

/** Quality numbers from FID-A's report (the full pipelines and the coil-combined path). */
export function preprocessingQc(report) {
  if (!report) return { averages: null, averagesRemoved: null, driftHz: null, fidaSnr: null, fidaLinewidthHz: null };
  const rm = report.rm_bad_averages;
  return {
    averages: rm?.averages_before ?? report.averages_raw ?? report.averagesRaw ?? null,
    averagesRemoved: rm ? rm.averages_before - rm.averages_after : null,
    driftHz: report.drift?.total_freq_drift ?? null,
    fidaSnr: report.snr ?? null,
    fidaLinewidthHz: report.linewidth_naa ?? report.linewidthHz ?? null,
  };
}

// Fractions are normalised to sum to 1; six digits hide the rounding.
const sixDigits = (x) => (x == null ? null : Number(x.toPrecision(6)));

/**
 * One dataset's line in the group table.
 * @param {{
 *   name: string, file?: string|null, format?: string|null, status: string,
 *   error?: string|null, basis?: string|null, edited?: boolean,
 *   unit?: string|null, ratioTo?: string|null,
 *   preprocessing?: object|null, summary?: {fwhmPpm?: number, snr?: number, shiftPpm?: number}|null,
 *   metabolites?: {name: string, concentration: number, sdPercent: number, ratio: number|null}[],
 *   macromoleculeModel?: string|null, lineBroadening?: string|null,
 *   correction?: {fractions: {gm: number, wm: number, csf: number}, source?: {kind: string}|null,
 *     rows: {name: string, corrected: number, alphaCorrected?: number|null}[]}|null,
 * }} parts  `preprocessing` is FID-A's report, `summary` LCModel's misc table,
 *   `correction` the tissue correction (tissue.js) when one was applied.
 */
export function groupRecord(parts) {
  const summary = parts.summary ?? {};
  const correction = parts.correction ?? null;
  const corrected = new Map((correction?.rows ?? []).map((r) => [r.name, r]));
  return {
    name: parts.name,
    file: parts.file ?? null,
    format: parts.format ?? null,
    status: parts.status,
    error: parts.error ?? null,
    basis: parts.basis ?? null,
    edited: Boolean(parts.edited),
    unit: parts.unit ?? null,
    ratioTo: parts.ratioTo ?? null,
    macromoleculeModel: parts.macromoleculeModel ?? null,
    lineBroadening: parts.lineBroadening ?? null,
    fractionGM: sixDigits(correction?.fractions.gm),
    fractionWM: sixDigits(correction?.fractions.wm),
    fractionCSF: sixDigits(correction?.fractions.csf),
    fractionSource: correction ? (correction.source?.kind ?? "entered") : null,
    ...preprocessingQc(parts.preprocessing),
    fwhmPpm: summary.fwhmPpm ?? null,
    lcmSnr: summary.snr ?? null,
    shiftPpm: summary.shiftPpm ?? null,
    metabolites: (parts.metabolites ?? []).map((m) => ({
      name: m.name,
      concentration: m.concentration,
      sdPercent: m.sdPercent,
      ratio: m.ratio ?? null,
      tissueCorrected: corrected.get(m.name)?.corrected ?? null,
      alphaCorrected: corrected.get(m.name)?.alphaCorrected ?? null,
    })),
  };
}

/** Metabolite names across the group, in the order LCModel first lists them. */
export function metaboliteNames(records) {
  const names = [];
  for (const record of records) {
    for (const m of record.metabolites) if (!names.includes(m.name)) names.push(m.name);
  }
  return names;
}

function csvCell(value) {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

const csvLine = (cells) => cells.map(csvCell).join(",");

function datasetCells(record) {
  return [
    record.name,
    record.file,
    record.status,
    record.error,
    record.format,
    record.basis,
    record.edited,
    record.unit,
    record.ratioTo,
    ...SETTING_COLUMNS.map((c) => record[c.key]),
    ...QC_COLUMNS.map((c) => record[c.key]),
  ];
}

/**
 * The group table, long: one row per dataset and metabolite, every row
 * carrying its dataset's unit, ratio reference and quality numbers. A failed
 * or cancelled dataset keeps one row with empty metabolite columns.
 */
export function groupCsvLong(records) {
  const header = [...DATASET_HEADERS, ...QC_COLUMNS.map((c) => c.header), "metabolite", ...METABOLITE_FIELDS.map((f) => f.header)];
  const lines = [csvLine(header)];
  for (const record of records) {
    const cells = datasetCells(record);
    if (!record.metabolites.length) {
      lines.push(csvLine([...cells, "", ...METABOLITE_FIELDS.map(() => "")]));
      continue;
    }
    for (const m of record.metabolites) lines.push(csvLine([...cells, m.name, ...METABOLITE_FIELDS.map((f) => m[f.key])]));
  }
  return `${lines.join("\n")}\n`;
}

/** The group table, wide: one row per dataset, a column per metabolite and field. */
export function groupCsvWide(records) {
  const names = metaboliteNames(records);
  const header = [...DATASET_HEADERS, ...QC_COLUMNS.map((c) => c.header), ...names.flatMap((n) => METABOLITE_FIELDS.map((f) => `${n}${f.suffix}`))];
  const lines = [csvLine(header)];
  for (const record of records) {
    const byName = new Map(record.metabolites.map((m) => [m.name, m]));
    const values = names.flatMap((n) => METABOLITE_FIELDS.map((f) => byName.get(n)?.[f.key]));
    lines.push(csvLine([...datasetCells(record), ...values]));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Which basis set each dataset of a group is fitted with.
 *
 * A dropped .BASIS file is the user's explicit choice and fits every dataset.
 * A library set the user picked over the selected dataset's recommendation
 * fits every dataset when it is usable for all of them, so the group shares
 * one basis. Otherwise each dataset gets its own recommendation: a folder may
 * mix protocols (PRESS and MEGA-PRESS, two echo times), and no single
 * simulated basis set is right for both.
 *
 * @param {{
 *   choice: string, custom: boolean, selectedRecommendation: string|null,
 *   datasets: {recommended: string|null, choiceUsable: boolean}[],
 * }} plan  `recommended` is null when no library set is usable for a dataset.
 * @returns {{mode: "custom"|"chosen"|"recommended", bases: (string|null)[], overridden: boolean}}
 *   `overridden` is true when the user's pick did not fit every dataset.
 */
export function planBases({ choice, custom, selectedRecommendation, datasets }) {
  if (custom) return { mode: "custom", bases: datasets.map(() => choice), overridden: false };
  const picked = choice !== selectedRecommendation;
  if (picked && datasets.every((d) => d.choiceUsable)) return { mode: "chosen", bases: datasets.map(() => choice), overridden: false };
  return { mode: "recommended", bases: datasets.map((d) => d.recommended), overridden: picked };
}

/**
 * Display names that tell datasets apart: the file stem, with as many parent
 * folders as it takes when two datasets share a stem (sub-01/metab, sub-02/metab).
 * @param {{name: string, path?: string|null}[]} datasets
 */
export function uniqueNames(datasets) {
  const folders = datasets.map((d) => (d.path ?? "").split("/").slice(0, -1));
  const names = datasets.map((d) => d.name);
  for (let depth = 1; ; depth += 1) {
    const counts = new Map();
    for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
    const clashing = names.map((n) => counts.get(n) > 1);
    if (!clashing.some(Boolean)) return names;
    let grew = false;
    names.forEach((_, k) => {
      if (!clashing[k] || depth > folders[k].length) return;
      names[k] = [...folders[k].slice(-depth), datasets[k].name].join("/");
      grew = true;
    });
    if (!grew) return names.map((n, k) => (clashing[k] ? `${n} (${k + 1})` : n));
  }
}

/** A file-name stem safe for downloads (no folders, no spaces). */
export function fileStem(name) {
  return String(name).replace(/\.[^./]+$/, "").replace(/[\\/]+/g, "_").replace(/[^\w.+-]+/g, "_") || "dataset";
}
