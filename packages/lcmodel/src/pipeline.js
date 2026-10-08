// The fit workflow the web app and the lcmodel command line share: the loaded
// input, the basis set and fit range each dataset gets, FID-A preprocessing and
// the LCModel fit of one dataset, and the files a fit is saved as. FID-A and
// LCModel run behind an injected engine: the app's worker, or the module
// loaded in Node. Everything else here is pure.
import packageJson from "../package.json" with { type: "json" };
import { assessBasis, parseBasisHeader, recommendBasis, sequenceFamily } from "./basis-select.js";
import { STATUS, fileStem, groupRecord, planBases, uniqueNames } from "./group.js";
import { FILES, buildControl, concentrationsCsv, fillGaps, parseCoord, parseTable, presentRows } from "./lcmodel-io.js";
import { parseRaw } from "./inputs.js";
import { buildReport } from "./report.js";

/** The basis choice for a user's own .BASIS file. */
export const CUSTOM = "custom";

/**
 * @typedef {{
 *   process(index: number, options: object): Promise<{lcmodel: object, report: object, spectrum?: object, unprocessed?: object, editOff?: object}>,
 *   fit(request: {control: string, files: Record<string, string>, basis: {name: string, library?: object, text?: string}, fdate: string}): Promise<{outputs: Record<string, string>}>,
 * }} Engine  FID-A preprocessing of a loaded dataset, and an LCModel run with
 *   a library basis set (`basis.library`, which the engine fetches and checks)
 *   or a supplied one (`basis.text`).
 *
 * @typedef {{library: object[], custom: {name: string, text: string, header: object, sha256?: string}|null}} Bases
 *
 * @typedef {{
 *   preprocessing: {removeBadAverages: boolean, badAverageSd?: number, driftCorrection: boolean, phaseAndReference: boolean},
 *   scaleWater: boolean, ecc: boolean, range: [number|null, number|null]|null,
 *   mmModel: "co-edited"|"none", lineBroadening: "widened"|"lcmodel",
 * }} Settings  A null `range` (or end) means each dataset's default.
 */

/** Versions a report names; `app` is the program running the fit. */
export function reportVersions(app) {
  return {
    app,
    lcmodel: `6.3-1N, Rust port (@neurodesk/lcmodel ${packageJson.version})`,
    fida: `Rust port (@neurodesk/lcmodel ${packageJson.version})`,
  };
}

/** Fit settings from the automation parameters (automation.json, parameters.json). */
export function settingsFrom(p = {}) {
  return {
    preprocessing: {
      removeBadAverages: p.removeBadAverages ?? true,
      badAverageSd: p.badAverageSd > 0 ? p.badAverageSd : undefined,
      driftCorrection: p.driftCorrection ?? true,
      phaseAndReference: p.phaseAndReference ?? true,
    },
    scaleWater: p.waterScaling ?? true,
    ecc: p.eddyCurrentCorrection ?? true,
    range: p.ppmStart == null && p.ppmEnd == null ? null : [p.ppmStart ?? null, p.ppmEnd ?? null],
    mmModel: p.macromoleculeModel ?? "co-edited",
    lineBroadening: p.lineBroadening ?? "widened",
  };
}

/** A user's own .BASIS file. */
export function parseCustomBasis(name, text) {
  const header = parseBasisHeader(text);
  if (!header.metabolites.length) throw new Error(`${name} is not an LCModel .BASIS file.`);
  return { name, text, header };
}

// ---------------------------------------------------------------------------
// The loaded input
// ---------------------------------------------------------------------------

/**
 * An LCModel .RAW (with an optional .H2O), fitted without preprocessing. Its
 * acquisition numbers come from its $SEQPAR block or an LCMODL control file.
 */
export function rawInput({ name, text, waterName = null, water = null, control = null }) {
  const raw = parseRaw(text);
  if (water && parseRaw(water).points !== raw.points) throw new Error("The water .RAW file has a different number of points from the spectrum.");
  const header = {
    hzpppm: raw.hzpppm ?? control?.hzpppm ?? null,
    teMs: raw.teMs ?? control?.teMs ?? null,
    deltat: raw.deltat ?? control?.deltat ?? null,
    sequence: raw.sequence,
  };
  return { kind: "raw", name, waterName, text, water, points: raw.points, header };
}

/** The datasets FID-A read, labelled so that subjects in their own folders stay apart. */
export function fidaInput(loaded) {
  const labels = uniqueNames(loaded.datasets);
  loaded.datasets.forEach((d, k) => {
    d.label = labels[k];
  });
  return { kind: "fida", datasets: loaded.datasets, index: 0, loadErrors: loaded.errors };
}

/**
 * The spectrometer frequency (MHz) and dwell time (ms) a .RAW is fitted with:
 * the given ones, else its own. The dwell time is kept to six digits in ms, as
 * the app's field shows it.
 */
export function rawAcquisition(input, { frequencyMHz, dwellTimeMs } = {}) {
  const header = input.header;
  const dwellMs = dwellTimeMs ?? (header.deltat ? +(header.deltat * 1000).toPrecision(6) : null);
  const hzpppm = frequencyMHz ?? header.hzpppm;
  return { hzpppm: hzpppm > 0 ? hzpppm : null, deltat: dwellMs > 0 ? dwellMs / 1000 : null };
}

/**
 * Edited MEGA-PRESS data: LCModel fits their difference spectrum. GE and
 * Philips files do not say; FID-A compares alternate transients
 * (header.editing), and `editOverride` holds the user's reading. A .RAW is a
 * difference spectrum when its $SEQPAR names MEGA-PRESS or the user says so.
 */
export function isEdited(input, k) {
  if (input?.kind === "raw") return input.editOverride ?? sequenceFamily(input.header.sequence) === "MEGA-PRESS";
  if (input?.kind !== "fida") return false;
  const ds = input.datasets[k];
  if (ds.header.editing) return ds.editOverride ?? ds.header.editing.detected;
  return ds.header.family === "MEGA-PRESS";
}

/**
 * The automation's `edited` parameter: the reading of GE and Philips
 * transients, and whether a .RAW is a difference spectrum.
 */
export function applyEditing(input, edited) {
  if (typeof edited !== "boolean") return;
  if (input.kind === "raw") input.editOverride = edited;
  else for (const ds of input.datasets) if (ds.header.editing) ds.editOverride = edited;
}

export function datasetLabel(input, k) {
  return input.kind === "raw" ? input.name : input.datasets[k].label;
}

export function describeDataset(input, k) {
  if (input.kind === "raw") return `${input.name} (LCModel .RAW, ${input.points} points)`;
  const ds = input.datasets[k];
  return `${ds.label} (${ds.format})`;
}

/** What the basis set is matched against, for dataset `k`. */
export function headerFor(input, k, acquisition) {
  if (input.kind === "raw") {
    const named = input.header.sequence;
    const sequence = isEdited(input, k) ? "MEGA-PRESS" : sequenceFamily(named) === "MEGA-PRESS" ? null : named;
    return { hzpppm: acquisition.hzpppm, teMs: input.header.teMs, sequence };
  }
  const ds = input.datasets[k];
  const sequence = isEdited(input, k) ? "MEGA-PRESS" : ds.header.family || ds.header.sequence;
  return { hzpppm: ds.header.hzpppm, teMs: ds.header.teMs, sequence };
}

// ---------------------------------------------------------------------------
// Basis set and fit range
// ---------------------------------------------------------------------------

/**
 * Fit ranges, ppm. With the co-edited macromolecule model a MEGA-PRESS
 * difference spectrum is fitted down to 0.5 ppm (buildControl leaves out
 * 1.2-1.95 ppm) so that the co-edited MM at 0.915 ppm constrains MM3co under
 * GABA (Zöllner et al. 2022); without it, LCModel's mega-press-3 preset
 * range, 4.2 to 1.95 ppm.
 */
export const RANGES = Object.freeze({ plain: ["4.0", "0.2"], "co-edited": ["4.2", "0.5"], none: ["4.2", "1.95"] });

/**
 * The macromolecule model a MEGA-PRESS fit with basis `choice` uses: the
 * requested `model`, except that MM-suppressed editing leaves no co-edited MM
 * to model and a user's own basis that already has an MM3co spectrum must not
 * get a second one.
 */
export function macromoleculeModel(choice, model, bases) {
  if (bases.library.find((b) => b.id === choice)?.mmSuppressed) return "none";
  if (choice === CUSTOM && bases.custom?.header.metabolites.some((m) => /^MM3/i.test(m))) return "none";
  return model;
}

/** The default fit range of dataset `k` fitted with basis `choice`, as the app's fields show it. */
export function defaultRangeText(input, k, choice, model, bases) {
  return isEdited(input, k) ? RANGES[macromoleculeModel(choice, model, bases)] : RANGES.plain;
}

/** The fit range fields still hold one of the defaults. */
export function rangeUntouched([start, end]) {
  return Object.values(RANGES).some((r) => r[0] === start && r[1] === end);
}

/** `choice` for these data, or an error saying why it does not fit them. */
export function checkBasis(header, choice, bases) {
  const basis = choice === CUSTOM ? { id: CUSTOM, ...bases.custom.header } : bases.library.find((b) => b.id === choice);
  if (!basis) throw new Error("No usable basis set for these data; supply a .BASIS file.");
  const assessment = assessBasis(header, basis);
  if (assessment.level === "error") throw new Error(`Basis set ${choice} does not fit these data: ${assessment.notes.map((n) => n.text).join(" ")}`);
  return assessment;
}

/**
 * The basis set one dataset is fitted with: the user's own, the requested
 * library set, or the recommended one.
 */
export function chooseBasis(input, k, { basisSet = "auto", bases, acquisition }) {
  const header = headerFor(input, k, acquisition);
  let choice;
  if (bases.custom) choice = CUSTOM;
  else if (basisSet !== "auto") choice = basisSet;
  else choice = recommendBasis(header, bases.library)?.basis.id;
  checkBasis(header, choice, bases);
  return choice;
}

/**
 * Which basis set each dataset of a group run gets (group.js planBases).
 * `explicit`: the choice was requested, not left at the recommendation.
 */
export function planGroup(input, { choice, explicit, bases, acquisition }) {
  const chosen = bases.library.find((b) => b.id === choice);
  const datasets = input.datasets.map((_, k) => {
    const header = headerFor(input, k, acquisition);
    return {
      recommended: recommendBasis(header, bases.library)?.basis.id ?? null,
      choiceUsable: Boolean(chosen) && assessBasis(header, chosen).usable,
    };
  });
  const selectedRecommendation = explicit ? null : datasets[input.index].recommended;
  const plan = planBases({ choice, custom: choice === CUSTOM, selectedRecommendation, datasets });
  const label = choice === CUSTOM ? `your basis set ${bases.custom.name}` : chosen?.label;
  plan.description = plan.mode === "custom" || plan.mode === "chosen"
    ? `Every dataset is fitted with ${label}.`
    : plan.overridden
      ? `${label} does not suit every dataset, so each is fitted with its recommended basis set.`
      : "Each dataset is fitted with its recommended basis set.";
  return plan;
}

/** The engine's basis input and the report's description of it. */
export async function basisFor(choice, bases) {
  if (choice === CUSTOM) {
    const custom = bases.custom;
    custom.sha256 ??= await sha256Hex(custom.text);
    return {
      job: { name: FILES.basis, text: custom.text },
      info: { id: CUSTOM, label: `Your basis set: ${custom.name}`, file: custom.name, sha256: custom.sha256 },
    };
  }
  const basis = bases.library.find((b) => b.id === choice);
  if (!basis) throw new Error("No usable basis set for these data; supply a .BASIS file.");
  return {
    job: { name: FILES.basis, library: basis.library },
    info: { id: basis.id, label: basis.label, file: basis.library.url, sha256: basis.library.sha256 },
  };
}

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------------------------------------------------------------------------
// Fitting
// ---------------------------------------------------------------------------

function preprocessingOptions(input, k, preprocessing) {
  return {
    ...preprocessing,
    edited: input.datasets[k].header.editing ? isEdited(input, k) : undefined,
  };
}

/** FID-A's report as one log line. */
export function summarizeReport(r) {
  const parts = [];
  const rm = r.rm_bad_averages;
  if (rm) parts.push(`${rm.averages_before - rm.averages_after} of ${rm.averages_before} averages removed`);
  if (r.drift?.total_freq_drift != null) parts.push(`drift ${r.drift.total_freq_drift.toFixed(2)} Hz`);
  if (r.snr != null) parts.push(`SNR ${Math.round(r.snr)}`);
  const lw = r.linewidth_naa ?? r.linewidthHz;
  if (lw != null) parts.push(`NAA linewidth ${lw.toFixed(1)} Hz`);
  return parts.join(", ") || r.pipeline;
}

/**
 * Preprocess (FID-A) and fit (LCModel) dataset `k` with basis `choice` over
 * `range` ([start, end] ppm).
 * @param {Engine} engine
 * @returns a fitted entry; throws when either step fails.
 */
export async function fitDataset(engine, { input, index: k, choice, range, settings, bases, acquisition, generated = new Date(), onStep = () => {}, log = () => {} }) {
  const name = datasetLabel(input, k);
  let fida = null;
  let lcm;
  if (input.kind === "fida") {
    onStep("Preprocessing with FID-A…");
    fida = await engine.process(k, preprocessingOptions(input, k, settings.preprocessing));
    for (const w of fida.report.warnings ?? []) log(`${name}: ${w}`, "warning");
    for (const w of fida.lcmodel.warnings ?? []) log(`${name}: ${w}`, "warning");
    log(`FID-A, ${name}: ${summarizeReport(fida.report)}`);
    lcm = fida.lcmodel;
  } else {
    lcm = { raw: input.text, h2o: input.water, nunfil: input.points, deltat: acquisition.deltat, hzpppm: acquisition.hzpppm, teMs: input.header.teMs, edited: isEdited(input, k) };
  }
  const water = settings.scaleWater && Boolean(lcm.h2o);
  const mmModel = lcm.edited ? macromoleculeModel(choice, settings.mmModel, bases) : null;
  // MEGA-PRESS keeps LCModel's own line-broadening prior.
  const lineBroadening = lcm.edited ? "lcmodel" : settings.lineBroadening;
  const control = buildControl({
    nunfil: lcm.nunfil,
    deltat: lcm.deltat,
    hzpppm: lcm.hzpppm,
    teMs: lcm.teMs,
    water,
    ecc: settings.ecc,
    ppmStart: range[0],
    ppmEnd: range[1],
    title: describeDataset(input, k),
    sptype: lcm.edited ? "mega-press-3" : "",
    coEditedMM: mmModel === "co-edited",
    lineBroadening,
  });
  const files = { [FILES.raw]: lcm.raw };
  if (water) files[FILES.h2o] = lcm.h2o;
  const basis = await basisFor(choice, bases);
  onStep("Fitting with LCModel…");
  const out = await engine.fit({ control, files, basis: basis.job, fdate: generated.toString() });
  const parsed = parseCoord(out.outputs[FILES.coord] ?? "");
  const coord = { ...parsed, gaps: fillGaps(parsed, lcm.raw, lcm) };
  const tableText = out.outputs[FILES.table] ?? "";
  const table = parseTable(tableText);
  for (const d of coord.diagnostics) log(`LCModel, ${name}: ${d}`, "info");
  return {
    index: k,
    status: STATUS.fitted,
    generated,
    basis: basis.info,
    processed: fida,
    fit: {
      coord,
      table: tableText,
      outputs: out.outputs,
      control,
      lcm,
      water,
      rows: presentRows(table.rows.length ? table.rows : coord.rows),
      ratioTo: table.ratioTo ?? coord.ratioTo,
      unit: water ? "mM" : "a.u.",
      range,
      macromoleculeModel: mmModel,
      lineBroadening,
    },
  };
}

/**
 * Fit dataset `k` with basis `basisId` and the run's settings: each end of the
 * fit range the settings leave open takes the dataset's default.
 */
export async function fitPlanned(engine, { input, index: k, basisId, settings, bases, acquisition, onStep, log }) {
  if (!basisId) throw new Error("No library basis set suits these data; supply a .BASIS file simulated for them.");
  if (basisId === CUSTOM) {
    const a = assessBasis(headerFor(input, k, acquisition), { id: CUSTOM, ...bases.custom.header });
    if (!a.usable) throw new Error(`Your basis set does not suit these data: ${a.notes.map((note) => note.text).join(" ")}`);
  }
  const [start, end] = defaultRangeText(input, k, basisId, settings.mmModel, bases).map(Number);
  const range = [settings.range?.[0] ?? start, settings.range?.[1] ?? end];
  return fitDataset(engine, { input, index: k, choice: basisId, range, settings, bases, acquisition, onStep, log });
}

export function failedEntry(k, error, basisId) {
  return { index: k, status: STATUS.failed, error: error.message, basis: basisId ? { id: basisId } : null, generated: new Date() };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** The report of one fit, as a complete HTML document. */
export function reportHtml(entry, input, versions) {
  const f = entry.fit;
  const ds = input.kind === "fida" ? input.datasets[entry.index] : null;
  const dataset = ds
    ? { name: ds.label, file: ds.path ?? ds.name, waterFile: ds.water ? (ds.waterPath ?? ds.water) : null, format: ds.format, header: ds.header, edited: Boolean(f.lcm.edited) }
    : { name: input.name, file: input.name, waterFile: input.waterName, format: "LCModel .RAW", header: { hzpppm: f.lcm.hzpppm, teMs: input.header.teMs, sequence: input.header.sequence, points: input.points }, edited: Boolean(f.lcm.edited) };
  const p = entry.processed;
  return buildReport({
    generated: `${entry.generated.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    versions,
    dataset,
    basis: entry.basis,
    control: f.control,
    preprocessing: p?.report ?? null,
    spectra: p ? { processed: p.spectrum, unprocessed: p.unprocessed, editOff: p.editOff } : null,
    fit: f,
  });
}

/**
 * A fit's downloads, keyed by role (the automation artifact roles), in the
 * order the app lists them. Each has `body`, or `make()` when it is built on
 * demand. The tissue correction's files come from tissue.js tissueTexts.
 */
export function resultTexts(entry, input, versions) {
  const { fit: f } = entry;
  const stem = fileStem(datasetLabel(input, entry.index));
  const text = (name, body, type = "text/plain") => ({ name, body, type });
  const entries = {
    concentrations: { description: "Concentrations (.csv)", ...text(`${stem}_concentrations.csv`, concentrationsCsv(f.rows, f.ratioTo), "text/csv"), viewable: false },
    fitReport: { description: "Report, printable (.html)", name: `${stem}_report.html`, type: "text/html", make: () => reportHtml(entry, input, versions) },
    table: { description: "LCModel table (.table)", ...text(`${stem}.table`, f.table), viewable: false },
    coord: { description: "LCModel fit curves (.coord)", ...text(`${stem}.coord`, f.outputs[FILES.coord] ?? "") },
    raw: { description: f.lcm.edited ? "Difference spectrum for LCModel (.RAW)" : "Spectrum for LCModel (.RAW)", ...text(`${stem}.RAW`, f.lcm.raw), viewable: false },
    control: { description: "LCModel control file", ...text(`${stem}.control`, f.control), viewable: false },
  };
  if (f.lcm.editOff) entries.editOff = { description: "Edit-OFF spectrum for LCModel (.RAW)", ...text(`${stem}_edit_off.RAW`, f.lcm.editOff), viewable: false };
  if (f.water) entries.h2o = { description: "Water reference for LCModel (.H2O)", ...text(`${stem}.H2O`, f.lcm.h2o), viewable: false };
  if (entry.processed) entries.preprocessing = { description: "FID-A report (.json)", ...text(`${stem}_fida.json`, JSON.stringify(entry.processed.report, null, 2), "application/json") };
  return entries;
}

/** Group table records, in dataset order, with unreadable files as failed rows. */
export function groupRecords(input, fits) {
  const indices = [...fits.keys()].sort((a, b) => a - b);
  const records = indices.map((k) => {
    const entry = fits.get(k);
    const ds = input.datasets[k];
    const f = entry.fit;
    return groupRecord({
      name: ds.label,
      file: ds.path ?? ds.name,
      format: ds.format,
      status: entry.status,
      error: entry.error,
      basis: entry.basis?.id,
      edited: f ? f.lcm.edited : isEdited(input, k),
      unit: f?.unit,
      ratioTo: f?.ratioTo,
      preprocessing: entry.processed?.report,
      summary: f?.coord.summary,
      metabolites: f?.rows,
      macromoleculeModel: f?.macromoleculeModel,
      lineBroadening: f?.lineBroadening,
      correction: f?.correction,
    });
  });
  for (const e of input.loadErrors ?? []) {
    indices.push(-1);
    records.push(groupRecord({ name: e.file, status: STATUS.failed, error: e.error }));
  }
  return { indices, records };
}

/** The measurements and provenance a single fit reports (the fit operation's). */
export function fitSummary(entry, basisName) {
  const f = entry.fit;
  const corrected = f.correction;
  return {
    measurements: {
      unit: f.unit,
      ratioTo: f.ratioTo ?? null,
      metabolites: Object.fromEntries(f.rows.map((r) => [r.name, { concentration: r.concentration, sdPercent: r.sdPercent, ratio: r.ratio ?? null, ...(r.note ? { note: r.note } : {}) }])),
      ...f.coord.summary,
      tissue: corrected
        ? {
          unit: corrected.constants.unit,
          method: corrected.constants.method,
          fractions: corrected.fractions,
          source: corrected.source,
          metaboliteRelaxation: corrected.constants.metaboliteRelaxation,
          metabolites: Object.fromEntries(corrected.rows.map((r) => [r.name, { corrected: r.corrected, alphaCorrected: r.alphaCorrected ?? null }])),
        }
        : null,
    },
    provenance: {
      basisSet: basisName,
      pipeline: entry.processed?.report.pipeline ?? "LCModel .RAW, no preprocessing",
      sptype: f.lcm.edited ? "mega-press-3" : null,
      macromoleculeModel: f.macromoleculeModel,
      lineBroadening: f.lineBroadening,
      control: f.control,
    },
  };
}

/** Each dataset of a group run, as the fit-group operation reports it. */
export function groupMeasurements(records) {
  return records.map((r) => ({
    name: r.name,
    file: r.file,
    status: r.status,
    error: r.error,
    basisSet: r.basis,
    edited: r.edited,
    unit: r.unit,
    ratioTo: r.ratioTo,
    fwhmPpm: r.fwhmPpm,
    snr: r.lcmSnr,
    shiftPpm: r.shiftPpm,
    fidaSnr: r.fidaSnr,
    fidaLinewidthHz: r.fidaLinewidthHz,
    averagesRemoved: r.averagesRemoved,
    macromoleculeModel: r.macromoleculeModel,
    lineBroadening: r.lineBroadening,
    tissueFractions: r.fractionSource ? { gm: r.fractionGM, wm: r.fractionWM, csf: r.fractionCSF, source: r.fractionSource } : null,
    metabolites: Object.fromEntries(r.metabolites.map((m) => [m.name, { concentration: m.concentration, sdPercent: m.sdPercent, ratio: m.ratio, tissueCorrected: m.tissueCorrected, alphaCorrected: m.alphaCorrected }])),
  }));
}
