// DOM-free steps of the dwicorrect workflow: what the series is, the settings that suit it
// (each with the rule that chose it), the shoreline command line, and the BIDS outputs.
import { isReversePair, phaseEncoding } from "@neurodesk/sdc";

/** Volumes with b ≤ this are b = 0 (shoreline's threshold). */
export const B0_MAX = 50;
/** b-values within this of a shell's first b-value belong to the shell (shoreline's rule). */
export const SHELL_WIDTH = 100;
/** More distinct b-values than this: not shelled (DSI, spread b). */
export const SHELLED_AT_MOST = 6;
/** 3dSHORE needs one diffusion-weighted volume per coefficient. */
export const SHORE_MIN_DWI = 72;

/** Whitespace-separated numbers of a text file. */
export function numbers(text) {
  return text.trim().split(/\s+/).filter(Boolean).map(Number);
}

/** The b-values and b-vectors (3 × n, FSL's layout) of a series of `frames` volumes. */
export function readGradients(bvalText, bvecText, frames) {
  const bvals = numbers(bvalText);
  if (bvals.length !== frames || bvals.some((b) => !Number.isFinite(b))) {
    throw new Error(`The bval has ${bvals.length} values for ${frames} volumes.`);
  }
  const rows = bvecText.trim().split(/\n/).map(numbers).filter((row) => row.length);
  const columns = rows.length === 3 && rows.every((row) => row.length === frames);
  const byRow = rows.length === frames && rows.every((row) => row.length === 3);
  if (!columns && !byRow) throw new Error(`The bvec does not hold ${frames} directions.`);
  const bvecs = columns ? rows : [0, 1, 2].map((c) => rows.map((row) => row[c]));
  if (bvecs.flat().some((v) => !Number.isFinite(v))) throw new Error("The bvec holds a value that is not a number.");
  return { bvals, bvecs };
}

/** Each volume's shell (0 for b = 0), clustered as shoreline clusters them. */
export function shellOf(bvals) {
  const centres = [];
  for (const b of bvals) {
    if (b > B0_MAX && !centres.some((c) => Math.abs(c - b) <= SHELL_WIDTH)) centres.push(b);
  }
  return bvals.map((b) => (b <= B0_MAX ? 0 : centres.reduce((best, c) => (Math.abs(c - b) < Math.abs(best - b) ? c : best))));
}

/** The sidecar's MultibandAccelerationFactor when it is a whole number that divides the slices, else null. */
function declaredMultiband(sidecar, slices) {
  const declared = Number(sidecar?.MultibandAccelerationFactor);
  return Number.isInteger(declared) && declared >= 1 && slices % declared === 0 ? declared : null;
}

/** The multiband factor from a BIDS sidecar: MultibandAccelerationFactor, else SliceTiming's repeats. */
export function multibandFactor(sidecar, slices) {
  const declared = declaredMultiband(sidecar, slices);
  if (declared > 1) return declared;
  const timing = sliceTiming(sidecar, slices);
  if (!timing) return 1;
  const groups = new Set(timing).size;
  return slices % groups === 0 && slices / groups > 1 ? slices / groups : 1;
}

/** SliceTiming when it has one number per slice, else null. */
export function sliceTiming(sidecar, slices) {
  const timing = sidecar?.SliceTiming;
  if (!Array.isArray(timing) || timing.length !== slices || timing.some((t) => !Number.isFinite(Number(t)))) return null;
  return timing.map(Number);
}

/** What the series is: volumes, shells, model, multiband, slice timing, phase encoding. */
export function describeSeries({ bvals, sidecar, dims }) {
  const shells = shellOf(bvals);
  const dwi = shells.filter((s) => s > 0).length;
  const counts = new Map();
  for (const s of shells) if (s > 0) counts.set(s, (counts.get(s) ?? 0) + 1);
  const slices = dims[2];
  const pe = sidecar?.PhaseEncodingDirection ?? null;
  // Refused at load, not after the brain mask: shoreline and PyHySCO take i, i-, j or j-.
  if (pe !== null) {
    try {
      phaseEncoding(pe);
    } catch {
      throw new Error(`The sidecar's PhaseEncodingDirection is ${JSON.stringify(pe)}; DWI Correct needs i, i-, j or j-.`);
    }
  }
  const readout = Number(sidecar?.TotalReadoutTime);
  const dwiB = bvals.filter((b) => b > B0_MAX);
  return {
    bRange: dwiB.length ? [Math.min(...dwiB), Math.max(...dwiB)] : null,
    volumes: bvals.length,
    b0: bvals.length - dwi,
    dwi,
    shells: [...counts].sort((a, b) => a[0] - b[0]).map(([b, count]) => ({ b, count })),
    shelled: counts.size <= SHELLED_AT_MOST,
    slices,
    multiband: multibandFactor(sidecar, slices),
    // Whether the sidecar gives a usable multiband factor (or SliceTiming shows it); else the
    // user can. A factor that does not divide the slices is not usable.
    multibandKnown: declaredMultiband(sidecar, slices) !== null || sliceTiming(sidecar, slices) !== null,
    sliceTiming: sliceTiming(sidecar, slices) !== null,
    phaseEncodingDirection: pe,
    totalReadoutTime: Number.isFinite(readout) && readout > 0 ? readout : null,
  };
}

/** A b-value as the summary shows it: to the nearest 50 (scanners write 995 or 2005). */
const shownB = (b) => Math.round(b / 50) * 50;

/**
 * The lines that describe the input under the file picker: the file, the volumes and shells,
 * the acquisition (multiband and slice timing only when present), and the field source.
 * `entered` holds the phase encoding, readout and multiband factor given in the fields when the
 * sidecar lacks them.
 */
export function inputSummary({ name, series, reverse = null, field = null, entered = {} }) {
  // Non-breaking spaces inside an item, so that a narrow sidebar wraps only between items.
  const nb = (text) => text.replaceAll(" ", "\u00a0");
  const shells = series.shelled
    ? series.shells.map(({ b, count }) => `b${shownB(b)}×${count}`)
    : [nb(`${series.dwi} DWI, b ${shownB(series.bRange[0])}–${shownB(series.bRange[1])}`)];
  const pe = series.phaseEncodingDirection ?? entered.pe;
  const readout = series.totalReadoutTime ?? entered.readout;
  const given = !series.phaseEncodingDirection || !series.totalReadoutTime ? " (set below)" : "";
  const acquisition = [
    pe ? `PE ${pe}${readout > 0 ? `, ${Math.round(readout * 1000)} ms readout` : ""}${given}` : "PE: not in sidecar",
    ...(series.multiband > 1 ? [`multiband ${series.multiband}`] : []),
    ...(!series.multibandKnown && entered.multiband > 1 ? [`multiband ${entered.multiband} (set below)`] : []),
    ...(series.sliceTiming ? ["slice timing"] : []),
  ];
  return [
    name,
    `${series.volumes} vol: ${[nb(`${series.b0} b0`), ...shells].join(" · ")}`,
    acquisition.join(" · "),
    ...(field ? [`Field map: ${field}`] : reverse ? [`Reverse-PE b0: ${reverse}`] : []),
  ];
}

/**
 * The settings that suit the series, each with the rule that chose it (shown as the field's
 * note). `field` is "reverse", "upload" or "none": the field source that the inputs allow.
 */
export function defaultSettings(series, field) {
  const shore = series.dwi >= SHORE_MIN_DWI;
  const grouped = series.multiband > 1;
  return {
    model: {
      value: shore ? "shore" : "gp",
      rule: shore ? `≥ ${SHORE_MIN_DWI} DWIs → 3dSHORE (${series.dwi})` : `< ${SHORE_MIN_DWI} DWIs → Gaussian process (${series.dwi})`,
    },
    shelled: {
      value: series.shelled,
      rule: series.shelled ? `≤ ${SHELLED_AT_MOST} b-values → shelled (${series.shells.length})` : `> ${SHELLED_AT_MOST} b-values → not shelled (${series.shells.length})`,
    },
    outliers: {
      value: grouped ? "both" : "sw",
      rule: grouped ? `Multiband ${series.multiband} → slices and whole groups` : "No multiband → single slices",
    },
    sliceToVolume: {
      value: false,
      available: series.sliceTiming,
      rule: series.sliceTiming ? "Slice timing found → available, about 1.8× the time" : "No SliceTiming → unavailable",
    },
    field: {
      value: field,
      rule: { reverse: "Reverse-PE b0 found → estimate the field", upload: "Field map loaded → use it", none: "No field → motion and eddy currents only" }[field],
    },
    eddyCurrents: { value: "quadratic", rule: "Quadratic field, linear in the gradient (eddy's defaults)" },
    iterations: { value: 5, rule: "5 iterations (eddy's default)" },
  };
}

/** The series with the multiband factor given in the field when the sidecar has none; throws when it does not divide the slices. */
export function withMultiband(series, entered) {
  if (series.multibandKnown) return series;
  const factor = Math.round(Number(entered));
  const multiband = Number.isInteger(factor) && factor > 1 ? factor : 1;
  if (series.slices % multiband) throw new Error(`The multiband factor ${multiband} does not divide the ${series.slices} slices.`);
  return { ...series, multiband };
}

/** The acqp row of a BIDS phase-encoding direction, in FSL's voxel axes (x reversed when det > 0). */
export function acqpRow(code, readout, affine) {
  const { axis, sign } = phaseEncoding(code);
  const vector = [0, 0, 0];
  vector[axis] = sign;
  if (axis === 0 && determinant(affine) > 0) vector[0] = -vector[0];
  return `${vector.join(" ")} ${readout}`;
}

function determinant(a) {
  return a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1])
    - a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0])
    + a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0]);
}

/** File names inside the WebAssembly session. */
export const SESSION = Object.freeze({
  series: "dwi.nii.gz",
  mask: "mask.nii.gz",
  field: "field.nii.gz",
  topup: "topup",
  sidecar: "dwi.json",
  acqp: "acqp",
  index: "index",
  bvals: "bvals",
  bvecs: "bvecs",
  out: "out",
});

/**
 * The shoreline command line for these settings. `field` is "estimated" or "hz" (a field map
 * in Hz on the series' grid, as `SESSION.field`), "topup" (`SESSION.topup`_fieldcoef.nii.gz)
 * or "none".
 */
export function shorelineArgs({ settings, series, field }) {
  const args = [
    `--imain=${SESSION.series}`,
    `--mask=${SESSION.mask}`,
    `--acqp=${SESSION.acqp}`,
    `--index=${SESSION.index}`,
    `--bvecs=${SESSION.bvecs}`,
    `--bvals=${SESSION.bvals}`,
    `--out=${SESSION.out}`,
    `--niter=${settings.iterations}`,
    "--fwhm=2",
    `--flm=${settings.eddyCurrents}`,
    `--slm=${settings.eddyCurrents === "movement" ? "none" : "linear"}`,
    `--model=${settings.model}`,
  ];
  if (settings.replaceOutliers !== false) args.push("--repol", `--ol_type=${settings.outliers}`);
  if (field === "topup") args.push(`--topup=${SESSION.topup}`);
  else if (field === "hz" || field === "estimated") args.push(`--field=${SESSION.field}`);
  if (series.sliceTiming) args.push(`--json=${SESSION.sidecar}`);
  else if (series.multiband > 1) args.push(`--mb=${series.multiband}`);
  if (settings.sliceToVolume && series.sliceTiming) args.push("--mporder=6");
  return args;
}

/** BIDS suffixes of a diffusion series. */
const SUFFIXES = new Set(["dwi", "epi", "sbref"]);

/** BIDS stem of an image name, without its suffix and any desc entity; other names whole. */
export function bidsStem(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  const stem = match && SUFFIXES.has(match[2]) ? match[1] : base;
  return stem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
}

/** Output names, BIDS derivatives of the series' stem. */
export function outputNames(seriesName) {
  const stem = bidsStem(seriesName);
  return {
    dwi: `${stem}_desc-preproc_dwi.nii.gz`,
    bval: `${stem}_desc-preproc_dwi.bval`,
    bvec: `${stem}_desc-preproc_dwi.bvec`,
    sidecar: `${stem}_desc-preproc_dwi.json`,
    confounds: `${stem}_desc-confounds_timeseries.tsv`,
    outliers: `${stem}_desc-sliceoutliers_timeseries.tsv`,
    mask: `${stem}_desc-brain_mask.nii.gz`,
    field: `${stem}_fieldmap.nii.gz`,
    fieldSidecar: `${stem}_fieldmap.json`,
    log: `${stem}_desc-dwicorrect_log.txt`,
    preview: `${stem}_desc-beforeafter_dwi.gif`,
    zip: `${stem}_desc-preproc_dwi.zip`,
  };
}

/** Rows of a text table of numbers, skipping eddy's header lines. */
export function table(text) {
  return text.split("\n").map((line) => line.trim()).filter((line) => /^[-+0-9.]/.test(line)).map(numbers);
}

/**
 * The confounds TSV: per volume, the movement (mm, and radians about the grid centre along
 * the voxel axes), the RMS displacement against the reference and the previous volume (mm),
 * and the number of outlier slices.
 */
export function confoundsTsv({ parameters, movementRms, outlierMap }) {
  const motion = table(parameters);
  const rms = table(movementRms);
  const outliers = outlierMap ? table(outlierMap) : null;
  const header = ["trans_x", "trans_y", "trans_z", "rot_x", "rot_y", "rot_z", "rms_reference", "rms_previous", "outlier_slices"];
  const rows = motion.map((row, v) => [
    ...row.slice(0, 6).map((x) => x.toFixed(6)),
    ...(rms[v] ?? [NaN, NaN]).map((x) => x.toFixed(6)),
    String(outliers ? outliers[v].reduce((sum, flag) => sum + flag, 0) : 0),
  ]);
  return `${[header, ...rows].map((row) => row.join("\t")).join("\n")}\n`;
}

/** The outlier map as a TSV: one row per volume, one column per slice (1: replaced). */
export function outliersTsv(outlierMap, slices) {
  const rows = table(outlierMap);
  const header = Array.from({ length: slices }, (_, s) => `slice_${s}`);
  return `${[header, ...rows.map((row) => row.map(String))].map((row) => row.join("\t")).join("\n")}\n`;
}

/** Per-volume summary for the report: movement, RMS displacement and outlier slices. */
export function motionSummary({ parameters, movementRms, outlierMap }) {
  const motion = table(parameters);
  const rms = table(movementRms);
  const outliers = outlierMap ? table(outlierMap) : null;
  return motion.map((row, v) => ({
    volume: v,
    translation: row.slice(0, 3),
    rotationDegrees: row.slice(3, 6).map((r) => (r * 180) / Math.PI),
    rms: rms[v]?.[0] ?? NaN,
    rmsPrevious: rms[v]?.[1] ?? NaN,
    outlierSlices: outliers ? outliers[v].flatMap((flag, s) => (flag ? [s] : [])) : [],
  }));
}

/**
 * The sidecar of the estimated field map (BIDS `_fieldmap.json`): Units Hz, and the sign
 * convention and the acquisition it applies to.
 */
export function fieldmapSidecar({ pe, readout, reverse, version }) {
  return {
    Units: "Hz",
    Description: `Susceptibility off-resonance field estimated by PyHySCO from the mean b0 of the series and of ${reverse}, in topup's sign convention: the series corrected is series(x + u(x)), with u = field × TotalReadoutTime × the sign of PhaseEncodingDirection, in voxels along the phase-encoding axis.`,
    PhaseEncodingDirection: pe,
    TotalReadoutTime: readout,
    GeneratedBy: [{ Name: "dwicorrect", Version: version, CodeURL: "https://github.com/neurodesk/webapps" }],
  };
}

/** The sidecar of the corrected series: the input's, plus what was done. */
export function preprocSidecar({ input, settings, args, field, fieldUnits = null, threads, seconds, mask, version }) {
  const sidecar = { ...input };
  sidecar.SkullStripped = false;
  sidecar.Sources = [input.Sources ?? []].flat();
  sidecar.GeneratedBy = [
    {
      Name: "dwicorrect",
      Version: version,
      Description: "Head motion, eddy-current and susceptibility distortion and slice outlier correction (shoreline, eddy-like), one resampling with Jacobian modulation.",
      CodeURL: "https://github.com/neurodesk/webapps",
    },
  ];
  sidecar.DwicorrectSettings = {
    PredictionModel: settings.model === "shore" ? "3dSHORE" : "Gaussian process",
    EddyCurrentModel: settings.eddyCurrents,
    OutlierReplacement: settings.outliers,
    SliceToVolume: Boolean(settings.sliceToVolume),
    Iterations: settings.iterations,
    SusceptibilityField: field,
    ...(fieldUnits ? { SusceptibilityFieldUnits: fieldUnits } : {}),
    BrainMask: mask,
    Threads: threads,
    Seconds: Math.round(seconds),
    CommandLine: `shoreline ${args.join(" ")}`,
  };
  return sidecar;
}

/**
 * The inputs of a selection: the DWI series (the one with gradients and the most volumes), a
 * reverse phase-encoding image on its grid, and a field map (topup coefficients or a field in
 * Hz). `series` entries are { image, sidecar, bval, bvec, frames, sameGrid, intent }.
 */
/** BIDS fieldmap Units and the factor that gives Hz. */
const FIELD_UNITS = Object.freeze({ Hz: 1, "rad/s": 1 / (2 * Math.PI) });

const isTopup = (entry) => entry.intent === 2016 || /_fieldcoef\.nii(\.gz)?$/i.test(entry.image.name);
const isFieldmap = (entry) => !isTopup(entry) && (/_fieldmap\.nii(\.gz)?$/i.test(entry.image.name) || ["Hz", "rad/s", "T", "Tesla"].includes(entry.sidecar?.Units));
const isField = (entry) => isTopup(entry) || isFieldmap(entry);

/** The DWI series of a selection: of the images with gradients (not field maps), the one with the most volumes, then by name. */
export function chooseDwi(series) {
  const withGradients = series.filter((entry) => !isField(entry) && entry.bval && entry.bvec);
  return [...withGradients].sort((a, b) => b.frames - a.frames || a.image.name.localeCompare(b.image.name))[0] ?? null;
}

/**
 * The inputs of a selection: the DWI series (`chooseDwi`), a reverse phase-encoding image on
 * its grid, and a field map (topup coefficients, or a field map in Hz or rad/s with `scale` to
 * Hz). `series` entries are { image, sidecar, bval, bvec, frames, intent }, and `sameGrid(entry,
 * dwi)` says whether an image is on the series' grid (else each entry's `sameGrid`).
 */
export function classifyInputs(series, { sameGrid = (entry) => Boolean(entry.sameGrid) } = {}) {
  const fields = series.filter(isField);
  const images = series.filter((entry) => !fields.includes(entry));
  const dwi = chooseDwi(series);
  if (!dwi) {
    throw new Error("Choose a diffusion series with its .bval and .bvec (and its JSON sidecar).");
  }
  if (fields.length > 1) throw new Error("Choose at most one field map: topup's _fieldcoef image or a field map in Hz.");
  const onGrid = (entry) => sameGrid(entry, dwi);
  const pe = dwi.sidecar?.PhaseEncodingDirection;
  const reverse = pe
    ? images.filter((entry) => entry !== dwi && entry.sidecar?.PhaseEncodingDirection && isReversePair(pe, entry.sidecar.PhaseEncodingDirection) && onGrid(entry))
    : [];
  if (reverse.length > 1) throw new Error("More than one reverse phase-encoding image; choose one.");
  const entry = fields[0] ?? null;
  let field = null;
  if (entry && isTopup(entry)) field = { entry, kind: "topup", scale: 1, units: null, sameGrid: onGrid(entry) };
  else if (entry) {
    // BIDS requires Units in a fieldmap's sidecar; without one the map is taken as Hz.
    const units = entry.sidecar?.Units ?? "Hz";
    const scale = FIELD_UNITS[units];
    if (!scale) throw new Error(`${entry.image.name} is in ${units}; give a field map in Hz or rad/s.`);
    if (!onGrid(entry)) throw new Error(`${entry.image.name} is not on the series' grid; give a field map in Hz on the DWI grid, or topup's _fieldcoef image.`);
    field = { entry, kind: "hz", scale, units, sameGrid: true };
  }
  return {
    dwi,
    reverse: reverse[0] ?? null,
    field,
    ignored: images.filter((entry) => entry !== dwi && entry !== reverse[0]).map((entry) => entry.image.name),
  };
}
