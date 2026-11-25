// Functional MRS viewer: condition QC summary, windowed temporal GLM,
// 2D dynamic spectral GLM, and clickable per-window QC table.
import { formatConc, SD_LIMIT } from "@neurodesk/lcmodel/report";

const fmt = (v, d = 2) => (v == null || !Number.isFinite(v) ? "—" : v.toFixed(d));
const fmtP = (p) => (p == null || !Number.isFinite(p) ? "—" : p < 0.0001 ? "<0.0001" : p.toFixed(4));
const fmtPct = (v) => (v == null || !Number.isFinite(v) ? "—" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

function cell(doc, tag, text, attrs = {}) {
  const el = doc.createElement(tag);
  el.textContent = text;
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function makeTable(doc, headers, rows) {
  const table = doc.createElement("table");
  table.className = "nd-data-table lcm-group";
  const thead = doc.createElement("thead");
  const hr = doc.createElement("tr");
  for (const h of headers) hr.append(cell(doc, "th", h));
  thead.append(hr);
  const tbody = doc.createElement("tbody");
  for (const r of rows) tbody.append(r);
  table.append(thead, tbody);
  return table;
}

function sectionHeading(doc, text) {
  const p = doc.createElement("p");
  p.className = "nd-section-title";
  p.textContent = text;
  return p;
}

/**
 * Render the fMRS summary & statistics tables into `host`.
 * Clicking a window row opens that window's individual LCModel fit.
 */
export function renderFmrsTables(host, fmrsResult, { selectedWindow = -1, onSelectWindow } = {}) {
  const doc = host.ownerDocument;
  const frag = doc.createDocumentFragment();

  // 1. Condition QC summary
  if (fmrsResult.conditionSummary?.length) {
    frag.append(sectionHeading(doc, "By condition"));
    const rows = fmrsResult.conditionSummary.map((c) => {
      const tr = doc.createElement("tr");
      tr.append(
        cell(doc, "th", c.condition, { scope: "row" }),
        cell(doc, "td", String(c.n)),
        cell(doc, "td", String(c.pass)),
        cell(doc, "td", String(c.warn)),
        cell(doc, "td", String(c.fail)),
        cell(doc, "td", fmt(c.medianLwHz, 1)),
        cell(doc, "td", fmt(c.deltaLwVsRefHz, 1)),
        cell(doc, "td", fmt(c.medianSnr, 1)),
        cell(doc, "td", fmt(c.medianTNaaToTCr, 3)),
      );
      return tr;
    });
    frag.append(makeTable(
      doc,
      ["Condition", "n", "PASS", "WARN", "FAIL", "Median LW (Hz)", `Δ LW vs ${fmrsResult.baselineCondition ?? "ref"} (Hz)`, "Median S/N", "Median tNAA/tCr"],
      rows,
    ));
  }

  // 2. Condition contrasts & temporal GLM (windowed + dynamic projection)
  const statRows = [];
  const pushContrasts = (modelLabel, list) => {
    for (const m of list ?? []) {
      for (const c of m.contrasts ?? []) {
        const tr = doc.createElement("tr");
        if (c.pValue != null && c.pValue < 0.05) tr.className = "lcm-combination";
        tr.append(
          cell(doc, "th", m.name, { scope: "row" }),
          cell(doc, "td", modelLabel),
          cell(doc, "td", `${c.condition} vs ${c.baseline}`),
          cell(doc, "td", c.beta == null ? "—" : formatConc(c.beta)),
          cell(doc, "td", c.se == null ? "—" : formatConc(c.se)),
          cell(doc, "td", fmtPct(c.percentChange)),
          cell(doc, "td", fmt(c.tStat, 2)),
          cell(doc, "td", fmtP(c.pValue)),
          cell(doc, "td", c.df == null ? "—" : String(c.df)),
          cell(doc, "td", c.reason ?? ""),
        );
        statRows.push(tr);
      }
    }
  };
  pushContrasts("Windowed GLM", fmrsResult.windowedStats?.metabolites);
  if (fmrsResult.dynamicGlm?.aligned !== false && fmrsResult.dynamicGlm) {
    pushContrasts("Dynamic projection", fmrsResult.dynamicGlm.metabolites);
    if (fmrsResult.dynamicGlm.boldLinewidth) {
      pushContrasts("Dynamic projection", [{ name: "BOLD LW (Hz)", contrasts: fmrsResult.dynamicGlm.boldLinewidth.contrasts }]);
    }
    if (fmrsResult.dynamicGlm.freqShift) {
      pushContrasts("Dynamic projection", [{ name: "Freq shift (Hz)", contrasts: fmrsResult.dynamicGlm.freqShift.contrasts }]);
    }
  }
  const statNotes = [];
  if (fmrsResult.windowedStats?.nExcludedQc > 0) {
    statNotes.push(`${fmrsResult.windowedStats.nExcludedQc} QC-FAIL window(s) excluded from windowed GLM.`);
  }
  if (fmrsResult.windowedStats?.overlappingWindows) {
    statNotes.push("Overlapping sliding windows share transients; windowed p-values are suppressed.");
  }
  if (fmrsResult.dynamicGlm?.aligned === false) {
    statNotes.push(fmrsResult.dynamicGlm.error);
  } else if (fmrsResult.dynamicGlm?.aligned) {
    statNotes.push(`Dynamic projection: alignment RMS ${(fmrsResult.dynamicGlm.alignmentRms ?? 0).toFixed(3)}, Newey-West HAC SEs (conditional on grand-mean templates).`);
  }
  if (statRows.length || statNotes.length) {
    frag.append(sectionHeading(doc, "Condition contrasts & temporal GLM"));
    if (statNotes.length) {
      const note = doc.createElement("p");
      note.className = fmrsResult.dynamicGlm?.aligned === false ? "nd-message warning" : "nd-hint";
      note.textContent = statNotes.join(" ");
      frag.append(note);
    }
    if (statRows.length) {
      frag.append(makeTable(
        doc,
        ["Metabolite", "Model", "Contrast", "Beta", "SE", "% Change", "t", "p", "df", "Note"],
        statRows,
      ));
    }
  }

  // 3. Per-window QC table (native button to inspect each window's LCModel fit)
  const pooled = fmrsResult.mode === "conditions";
  frag.append(sectionHeading(doc, "Windows (select a window to inspect its LCModel fit)"));
  const winRows = fmrsResult.windows.map((w, k) => {
    const tr = doc.createElement("tr");
    if (k === selectedWindow) tr.setAttribute("aria-current", "true");
    const first = doc.createElement("th");
    first.scope = "row";
    if (w.entry) {
      const btn = cell(doc, "button", w.label, {
        type: "button",
        class: "nd-btn nd-btn-secondary",
        title: `Show LCModel fit of ${w.label}`,
      });
      btn.addEventListener("click", () => onSelectWindow?.(k));
      first.append(btn);
    } else {
      first.textContent = w.label;
    }
    const glu = w.metabolites?.find((m) => m.name === "Glu");
    const gluCell = cell(doc, "td", glu ? `${formatConc(glu.concentration)} (${glu.sdPercent}%)` : "—");
    if (glu && glu.sdPercent > SD_LIMIT) gluCell.className = "lcm-uncertain";
    const statusCell = cell(doc, "td", w.qc?.status ?? w.status);
    if (w.qc?.status === "FAIL") statusCell.className = "lcm-error";
    const lbText = w.linewidthMatchStatus && w.linewidthMatchStatus !== "off"
      ? `${fmt(w.broadeningAppliedHz, 2)} (${w.linewidthMatchStatus})`
      : fmt(w.broadeningAppliedHz, 2);
    tr.append(
      first,
      cell(doc, "td", w.condition ?? "—"),
      cell(doc, "td", pooled ? "pooled" : fmt(w.midTimeS, 1)),
      cell(doc, "td", `${w.averagesKept}/${w.averagesTotal}`),
      statusCell,
      cell(doc, "td", fmt(w.fwhmPpm, 3)),
      cell(doc, "td", fmt(w.lwHz, 1)),
      cell(doc, "td", lbText),
      cell(doc, "td", fmt(w.lcmSnr, 0)),
      cell(doc, "td", fmt(w.qc?.tNaaToTCr, 3)),
      gluCell,
      cell(doc, "td", (w.qc?.reasons ?? []).join("; ") || (w.error ?? "")),
    );
    return tr;
  });
  frag.append(makeTable(
    doc,
    ["Window", "Condition", "Time (s)", "Kept", "QC", "FWHM (ppm)", "LW (Hz)", "LB added (Hz)", "S/N", "tNAA/tCr", "Glu (%SD)", "Notes"],
    winRows,
  ));

  host.replaceChildren(frag);
}
