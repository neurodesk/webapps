// The per-fit report that replaces LCModel's PostScript page (lps=0 in this
// port): one self-contained HTML document with inline SVG plots and its own
// print stylesheet, so it opens anywhere and prints to PDF from the browser.
// It is a downloaded document, not an app region: its CSS travels with it and
// never touches the workspace, which keeps the shared theme. Pure, Node-tested.
import { spectrumSvg, fitSeries, metaboliteSeries } from "./spectrum-plot.js";

/** %SD above which LCModel's Cramér-Rao estimate marks a value as unreliable. */
export const SD_LIMIT = 20;

const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/** Three significant figures, exponent form outside 0.01 to 1000 (as the app's table). */
export function formatConc(x) {
  if (x == null || !Number.isFinite(x)) return "";
  if (x === 0) return "0";
  return Math.abs(x) >= 0.01 && Math.abs(x) < 1000 ? x.toPrecision(3) : x.toExponential(2);
}

const fixed = (x, digits) => (x == null || !Number.isFinite(x) ? "" : x.toFixed(digits));

// The report's own print styles: black on white, LCModel's red fit line.
const STYLE = `
@page { size: A4; margin: 12mm; }
* { box-sizing: border-box; }
body { margin: 0 auto; max-width: 190mm; padding: 8mm 0; font: 9pt/1.35 system-ui, -apple-system, "Segoe UI", sans-serif; color: black; background: white; }
h1 { font-size: 14pt; margin: 0; }
h2 { font-size: 10pt; margin: 10pt 0 4pt; border-bottom: 0.5pt solid gray; padding-bottom: 2pt; }
.meta { color: dimgray; margin: 2pt 0 8pt; }
.top { display: grid; grid-template-columns: minmax(0, 1fr) 72mm; gap: 6mm; align-items: start; }
.columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0 6mm; }
figure { margin: 0; break-inside: avoid; }
figcaption { color: dimgray; font-size: 8pt; }
table { border-collapse: collapse; width: 100%; font-variant-numeric: tabular-nums; }
th, td { padding: 0.6pt 3pt; text-align: right; white-space: nowrap; }
th { border-bottom: 0.5pt solid black; font-weight: 600; }
td:last-child, th:last-child { text-align: left; }
.conc { font-size: 8pt; }
.conc tr.combination td:last-child { font-weight: 600; }
.conc tr.uncertain td { color: gray; }
.conc tr.uncertain td:nth-child(2)::after { content: " *"; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 1pt 8pt; margin: 0; }
dt { color: dimgray; }
dd { margin: 0; overflow-wrap: anywhere; }
ul { margin: 0; padding-left: 12pt; }
pre { font-size: 7.5pt; white-space: pre-wrap; margin: 0; }
pre.control { columns: 3; }
.note { color: dimgray; font-size: 8pt; }
.page { break-before: page; }
svg { display: block; width: 100%; height: auto; }
svg text { fill: dimgray; font-size: 11px; }
svg .lcm-label { fill: black; font-size: 10px; }
svg polyline { fill: none; stroke-linejoin: round; }
svg .lcm-axis { stroke: black; }
svg .lcm-grid { stroke: lightgray; stroke-dasharray: 2 4; }
svg .lcm-data, svg .lcm-reference { stroke: black; stroke-width: 0.8; }
svg .lcm-fit, svg .lcm-metabolite { stroke: red; stroke-width: 1.2; }
svg .lcm-background { stroke: dimgray; stroke-width: 0.8; stroke-dasharray: 4 3; }
svg .lcm-residual { stroke: dimgray; stroke-width: 0.6; }
@media print { body { padding: 0; } }
`;

function definitionList(pairs) {
  const items = pairs.filter(([, value]) => value != null && value !== "" && value !== false);
  return `<dl>${items.map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`).join("")}</dl>`;
}

/** Macromolecule models of a MEGA-PRESS fit (main.js, lcmodel-io.js). */
const MM_MODELS = {
  "co-edited": "co-edited MM3co tied to MM09 (Zöllner et al. 2022), 4.2-0.5 ppm without 1.2-1.95 ppm",
  none: "none: LCModel's mega-press-3 as is, 4.2-1.95 ppm, GABA is GABA+",
};

/** Line-broadening priors (lcmodel-io.js LINE_BROADENING). */
const LINE_BROADENING = {
  widened: "widened: DESDT2 2, RFWBAS 80 (the app's default)",
  lcmodel: "LCModel defaults: DESDT2 0.4, RFWBAS 10",
};

function concentrationTable(rows, { unit, ratioTo, correction }) {
  const tissue = correction?.rows ?? null;
  const alpha = tissue?.some((r) => r.alphaCorrected != null);
  const extra = tissue ? `<th>Tissue (mmol/kg)</th>${alpha ? "<th>Alpha</th>" : ""}` : "";
  const head = `<tr><th>Conc. (${escapeHtml(unit)})</th><th>%SD</th><th>${escapeHtml(ratioTo ? `/${ratioTo}` : "Ratio")}</th>${extra}<th>Metabolite</th></tr>`;
  const body = rows.map((r, k) => {
    const classes = [r.combination && "combination", r.sdPercent > SD_LIMIT && "uncertain"].filter(Boolean).join(" ");
    const t = tissue?.[k];
    const cells = tissue ? `<td>${formatConc(t?.corrected)}</td>${alpha ? `<td>${formatConc(t?.alphaCorrected)}</td>` : ""}` : "";
    return `<tr${classes ? ` class="${classes}"` : ""}><td>${formatConc(r.concentration)}</td><td>${escapeHtml(r.sdPercent)}%</td><td>${r.ratio == null ? "" : formatConc(r.ratio)}</td>${cells}<td>${escapeHtml(r.name)}</td></tr>`;
  }).join("");
  return `<table class="conc"><thead>${head}</thead><tbody>${body}</tbody></table><p class="note">* %SD above ${SD_LIMIT}%: the Cramér-Rao bound says the value is unreliable.</p>`;
}

/** The tissue correction's inputs: fractions, their source and the constants. */
function tissueSection(correction) {
  if (!correction?.rows) return "";
  const f = correction.fractions;
  const c = correction.constants;
  const source = correction.source?.kind === "segmentation"
    ? `MindMap partial-volume maps of the T1 (${correction.source.backend ?? "?"}); unlabelled voxel share counted as CSF`
    : "entered by the user";
  const w = c.waterConcentration;
  const list = definitionList([
    ["Method", c.method],
    ["Unit", c.unit],
    ["Fractions", `GM ${fixed(f.gm, 3)}, WM ${fixed(f.wm, 3)}, CSF ${fixed(f.csf, 3)}`],
    ["Fractions from", source],
    ["Tissue water", w && `GM ${w.gm}, WM ${w.wm}, CSF ${w.csf} mmol/kg (pure water ${w.pure})`],
    ["LCModel water scaling", c.lcmodel && `WCONC ${c.lcmodel.wconc}, ATTH2O ${c.lcmodel.atth2o}, ATTMET ${c.lcmodel.attmet}`],
    ["Metabolite relaxation", c.metaboliteRelaxation ? "corrected (literature T1, T2)" : "not corrected"],
    ["TE / TR", c.metabolite && `${c.metabolite.teMs} / ${c.metabolite.trMs} ms; water ${c.water.teMs} / ${c.water.trMs} ms`],
    ["Alpha", c.alpha != null && `${c.alpha} (Harris et al. 2015), GABA and Glx`],
  ]);
  return `<h2>Tissue correction</h2>${list}`;
}

function acquisition(dataset) {
  const h = dataset.header ?? {};
  const field = h.fieldT ? `${h.fieldT.toFixed(2)} T` : h.hzpppm ? `${(h.hzpppm / 42.577).toFixed(2)} T` : null;
  const editing = dataset.edited ? "MEGA-PRESS, edit-ON minus edit-OFF" : "none";
  return definitionList([
    ["Dataset", dataset.name],
    ["File", dataset.file],
    ["Water reference", dataset.waterFile ?? "none"],
    ["Format", dataset.format],
    ["Sequence", [h.sequence?.trim(), h.family && h.family !== h.sequence?.trim() ? `(${h.family})` : ""].filter(Boolean).join(" ")],
    ["Field", field && `${field}${h.hzpppm ? `, ${Number(h.hzpppm).toFixed(4)} MHz` : ""}`],
    ["TE / TR", h.teMs != null && `${h.teMs} ms${h.trMs ? ` / ${h.trMs} ms` : ""}`],
    ["Averages", h.averages],
    ["Coils", h.coils],
    ["Subspectra", h.subspectra > 1 ? h.subspectra : null],
    ["Points", h.points && `${h.points}${h.spectralWidthHz ? `, ${Math.round(h.spectralWidthHz)} Hz bandwidth` : ""}`],
    ["Editing", editing],
  ]);
}

function preprocessingSection(report) {
  if (!report) return "<p>LCModel .RAW input, fitted without preprocessing.</p>";
  const rm = report.rm_bad_averages;
  const warnings = report.warnings ?? [];
  const list = definitionList([
    ["Pipeline", report.pipeline === "combined" ? "coil-combined data: aligned and averaged" : report.pipeline],
    ["Averages", rm ? `${rm.averages_before - rm.averages_after} of ${rm.averages_before} removed (threshold ${rm.nsd} SD)` : report.averagesRaw ?? report.averages_raw],
    ["Frequency drift", report.drift?.total_freq_drift != null && `${fixed(report.drift.total_freq_drift, 2)} Hz`],
    ["Phase drift", report.drift?.total_phase_drift != null && `${fixed(report.drift.total_phase_drift, 1)} deg`],
    ["SNR (NAA)", report.snr != null && fixed(report.snr, 0)],
    ["Linewidth", (report.linewidth_naa ?? report.linewidthHz) != null && `${fixed(report.linewidth_naa ?? report.linewidthHz, 1)} Hz (NAA)`],
    ["Water linewidth", (report.linewidth_water ?? report.waterLinewidthHz) != null && `${fixed(report.linewidth_water ?? report.waterLinewidthHz, 1)} Hz`],
    ["Edit classification", report.editClassification && `NAA/Cr contrast ${fixed(report.editClassification.contrast, 1)}, edit-OFF ${report.editClassification.offFirst ? "first" : "second"}`],
    ["Conjugated", report.conjugated ? "yes (GE)" : null],
  ]);
  const notes = warnings.length ? `<ul>${warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join("")}</ul>` : "<p>No warnings.</p>";
  return `${list}<h2>FID-A warnings</h2>${notes}`;
}

function preprocessingPlot(spectra) {
  if (!spectra?.processed) return "";
  if (spectra.editOff) {
    const off = spectra.editOff.real;
    const diff = spectra.processed.real;
    const lift = Math.max(...diff) - Math.min(...off) + (Math.max(...off) - Math.min(...off)) * 0.1;
    const svg = spectrumSvg({
      ppm: spectra.processed.ppm,
      series: [
        { values: diff, kind: "fit", label: "Difference (edit-ON minus edit-OFF)" },
        { values: off, kind: "reference", label: "Edit-OFF", offset: lift },
      ],
      range: [4.5, 0.5],
      height: 300,
      ariaLabel: "MEGA-PRESS edit-OFF and difference spectra after FID-A preprocessing",
    });
    return `<figure>${svg}<figcaption>FID-A: edit-OFF (top, black) and the difference spectrum LCModel fits (bottom, red).</figcaption></figure>`;
  }
  const series = [{ values: spectra.processed.real, kind: "fit", label: "Preprocessed (FID-A)" }];
  if (spectra.unprocessed?.real?.length === spectra.processed.real.length) {
    series.unshift({ values: spectra.unprocessed.real, kind: "reference", label: "Coil-combined and averaged, no correction" });
  }
  const svg = spectrumSvg({ ppm: spectra.processed.ppm, series, range: [4.5, 0], height: 300, ariaLabel: "Spectrum before and after FID-A preprocessing" });
  return `<figure>${svg}<figcaption>FID-A preprocessing: black before, red after bad-average removal and drift correction.</figcaption></figure>`;
}

/**
 * The report for one fit.
 * @param {{
 *   generated: string,
 *   versions: {app: string, lcmodel: string, fida: string},
 *   dataset: {name: string, file?: string, waterFile?: string|null, format?: string, header?: object, edited?: boolean},
 *   basis: {id: string, label: string, sha256?: string|null, file?: string|null},
 *   control: string,
 *   preprocessing?: object|null,
 *   spectra?: {processed: {ppm: number[], real: number[]}, unprocessed?: {real: number[]}, editOff?: {real: number[]}|null}|null,
 *   fit: {coord: object, rows: object[], ratioTo: string|null, unit: string, range: [number, number],
 *     macromoleculeModel?: string|null, lineBroadening?: string|null, correction?: object|null},
 * }} input  `preprocessing` is FID-A's report, `coord` the parsed .COORD file,
 *   `rows` the concentration table and `correction` the tissue correction
 *   (tissue.js), whose rows follow `rows`.
 * @returns {string} a complete HTML document
 */
export function buildReport({ generated, versions, dataset, basis, control, preprocessing = null, spectra = null, fit }) {
  const { coord } = fit;
  const s = coord.summary ?? {};
  const title = `LCModel fit: ${dataset.name}`;
  const fitPlot = coord.ppm.length
    ? spectrumSvg({ ppm: coord.ppm, series: fitSeries(coord), range: fit.range, height: 640, ariaLabel: "LCModel fit: data, fit, baseline and residual" })
    : "<p>LCModel wrote no fit curves.</p>";
  const metabolites = metaboliteSeries(coord, { limit: 16 });
  const metabolitePlot = metabolites.length
    ? `<figure>${spectrumSvg({ ppm: coord.ppm, series: metabolites, range: fit.range, height: 440, ariaLabel: "Fitted metabolite spectra" })}<figcaption>Each fitted metabolite's contribution, baseline removed, largest at the bottom.</figcaption></figure>`
    : "";
  const fitSummary = definitionList([
    ["FWHM", s.fwhmPpm != null && `${s.fwhmPpm} ppm`],
    ["S/N", s.snr],
    ["Data shift", s.shiftPpm != null && `${s.shiftPpm} ppm`],
    ["Phase", s.phase0Deg != null && `${s.phase0Deg} deg, ${s.phase1DegPerPpm ?? 0} deg/ppm`],
    ["Fit range", `${fit.range[0]} to ${fit.range[1]} ppm`],
    ["Analysis", dataset.edited ? "MEGA-PRESS difference spectrum (sptype mega-press-3)" : "standard"],
    ["Macromolecule model", fit.macromoleculeModel && (MM_MODELS[fit.macromoleculeModel] ?? fit.macromoleculeModel)],
    ["Line-broadening prior", fit.lineBroadening && (LINE_BROADENING[fit.lineBroadening] ?? fit.lineBroadening)],
  ]);
  const diagnostics = coord.diagnostics?.length
    ? `<ul>${coord.diagnostics.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>`
    : "<p>No diagnostics.</p>";
  const basisList = definitionList([
    ["Basis set", basis.label],
    ["Identifier", basis.id],
    ["File", basis.file],
    ["SHA-256", basis.sha256],
  ]);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
<h1>${escapeHtml(title)}</h1>
<p class="meta">${escapeHtml(generated)} · LCModel web app ${escapeHtml(versions.app)} · LCModel ${escapeHtml(versions.lcmodel)} · FID-A ${escapeHtml(versions.fida)}</p>
</header>
<section class="top">
<figure>${fitPlot}<figcaption>Data (black), LCModel fit (red), baseline (dashed) and residual (top), as in LCModel's own page.</figcaption></figure>
<div>${concentrationTable(fit.rows, fit)}</div>
</section>
<section class="columns">
<div>
<h2>Fit quality</h2>
${fitSummary}
<h2>LCModel diagnostics</h2>
${diagnostics}
</div>
<div>
<h2>Data</h2>
${acquisition(dataset)}
<h2>Basis set</h2>
${basisList}
${tissueSection(fit.correction)}
</div>
</section>
<section class="page">
<h2>Preprocessing</h2>
<div class="columns"><div>${preprocessingSection(preprocessing)}</div><div>${preprocessingPlot(spectra)}</div></div>
${metabolitePlot ? `<h2>Metabolites</h2>${metabolitePlot}` : ""}
<h2>LCModel control file</h2>
<pre class="control">${escapeHtml(control)}</pre>
${coord.misc?.length ? `<h2>LCModel miscellaneous output</h2><pre>${escapeHtml(coord.misc.join("\n"))}</pre>` : ""}
</section>
</body>
</html>
`;
}
