// The group table in the viewer: datasets down, quality and metabolites
// across. Selecting a dataset's name shows its fit.
import { QC_COLUMNS, STATUS, metaboliteNames } from "@neurodesk/lcmodel/group";
import { formatConc, SD_LIMIT } from "@neurodesk/lcmodel/report";

const QC_DIGITS = { fidaSnr: 0, fidaLinewidthHz: 1, driftHz: 2, averagesRemoved: 0, averages: 0 };

function qcText(key, value) {
  if (value == null || !Number.isFinite(value)) return "";
  return key in QC_DIGITS ? value.toFixed(QC_DIGITS[key]) : String(value);
}

function cell(doc, tag, text, attributes = {}) {
  const node = doc.createElement(tag);
  node.textContent = text;
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, value);
  return node;
}

/**
 * @param {HTMLElement} host  emptied and filled with the table
 * @param {ReturnType<import("./group.js").groupRecord>[]} records
 * @param {{
 *   indices: number[], selected: number, show: "concentration"|"ratio"|"tissue",
 *   onSelect: (index: number) => void,
 * }} options  `indices` maps each record to its dataset index; -1 is a
 *   file that could not be read. "tissue" shows the tissue-corrected
 *   concentrations (mmol/kg), empty for datasets without a correction.
 */
const SHOWN = {
  concentration: { key: "concentration", what: "concentration", unit: (r) => r.unit },
  ratio: { key: "ratio", what: "ratio", unit: (r) => r.ratioTo },
  tissue: { key: "tissueCorrected", what: "tissue-corrected concentration, mmol/kg", unit: (r) => (r.fractionSource ? "mmol/kg" : "") },
};

export function renderGroupTable(host, records, { indices, selected, show, onSelect }) {
  const doc = host.ownerDocument;
  const shown = SHOWN[show] ?? SHOWN.concentration;
  const names = metaboliteNames(records);
  const table = doc.createElement("table");
  table.className = "nd-data-table lcm-group";
  table.id = "groupTable";
  const head = doc.createElement("tr");
  head.append(
    cell(doc, "th", "Dataset"),
    cell(doc, "th", "Status"),
    cell(doc, "th", "Basis"),
    cell(doc, "th", "Edited"),
    cell(doc, "th", show === "ratio" ? "Ratio to" : "Unit"),
    ...QC_COLUMNS.map((c) => cell(doc, "th", c.label, { title: c.title })),
    ...names.map((n) => cell(doc, "th", n, { title: `${n}: ${shown.what} (%SD)` })),
  );
  const body = doc.createElement("tbody");
  records.forEach((record, k) => {
    const index = indices[k];
    const row = doc.createElement("tr");
    row.dataset.dataset = String(index);
    if (index === selected) row.setAttribute("aria-current", "true");
    const first = doc.createElement("th");
    first.scope = "row";
    if (index >= 0) {
      const name = cell(doc, "span", record.name, { role: "button", tabindex: "0", title: `Show the fit of ${record.name}` });
      const select = () => onSelect(index);
      name.addEventListener("click", select);
      name.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        select();
      });
      first.append(name);
    } else {
      // A file FID-A could not read: nothing to show but the error.
      first.textContent = record.name;
    }
    row.append(
      first,
      cell(doc, "td", record.status),
      cell(doc, "td", record.basis ?? ""),
      cell(doc, "td", record.status === STATUS.fitted ? (record.edited ? "yes" : "no") : ""),
      cell(doc, "td", shown.unit(record) ?? ""),
    );
    if (record.status !== STATUS.fitted) {
      row.append(cell(doc, "td", record.error ?? record.status, { colspan: String(QC_COLUMNS.length + names.length), class: "lcm-error" }));
      body.append(row);
      return;
    }
    row.append(...QC_COLUMNS.map((c) => cell(doc, "td", qcText(c.key, record[c.key]))));
    const byName = new Map(record.metabolites.map((m) => [m.name, m]));
    for (const n of names) {
      const m = byName.get(n);
      const value = m ? m[shown.key] : null;
      const td = cell(doc, "td", value == null ? "" : `${formatConc(value)} (${m.sdPercent}%)`);
      if (m && m.sdPercent > SD_LIMIT) td.className = "lcm-uncertain";
      row.append(td);
    }
    body.append(row);
  });
  const thead = doc.createElement("thead");
  thead.append(head);
  table.append(thead, body);
  host.replaceChildren(table);
}
