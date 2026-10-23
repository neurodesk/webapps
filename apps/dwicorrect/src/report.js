// The Motion tab: displacement per volume (a shared .nd-chart) and a table of each volume's
// movement and replaced slices; choosing a row shows that volume of the corrected series.

const WIDTH = 640;
const HEIGHT = 180;
const MARGIN = { left: 34, right: 8, top: 8, bottom: 22 };
const round = (value) => Math.round(value * 10) / 10;

/** The SVG of the RMS displacement against the reference and the previous volume (mm). */
export function displacementChart(summary) {
  const n = summary.length;
  const top = Math.max(0.5, ...summary.map((row) => row.rms).filter(Number.isFinite));
  const scale = niceStep(top);
  const ceiling = Math.ceil(top / scale) * scale;
  const right = WIDTH - MARGIN.right;
  const bottom = HEIGHT - MARGIN.bottom;
  const x = (v) => round(MARGIN.left + ((right - MARGIN.left) * v) / Math.max(1, n - 1));
  const y = (mm) => round(bottom - ((bottom - MARGIN.top) * mm) / ceiling);
  const line = (key) => summary.filter((row) => Number.isFinite(row[key])).map((row) => `${x(row.volume)},${y(row[key])}`).join(" ");
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" class="nd-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="RMS displacement per volume">`];
  for (let value = 0; value <= ceiling + 1e-9; value += scale) {
    parts.push(`<line class="nd-chart-gridline" x1="${MARGIN.left}" x2="${right}" y1="${y(value)}" y2="${y(value)}"/>`);
    parts.push(`<text x="${MARGIN.left - 4}" y="${y(value) + 3}" text-anchor="end">${Number(value.toFixed(2))}</text>`);
  }
  parts.push(`<line class="nd-chart-axis" x1="${MARGIN.left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`);
  for (const v of ticks(n)) parts.push(`<text x="${x(v)}" y="${HEIGHT - 6}" text-anchor="middle">${v + 1}</text>`);
  parts.push(`<polyline class="nd-chart-range" points="${line("rmsPrevious")}"/>`);
  parts.push(`<polyline class="nd-chart-median" points="${line("rms")}"/>`);
  for (const row of summary) {
    if (row.outlierSlices.length && Number.isFinite(row.rms)) parts.push(`<circle class="nd-chart-marker" cx="${x(row.volume)}" cy="${y(row.rms)}" r="3"/>`);
  }
  parts.push("</svg>");
  return parts.join("");
}

function niceStep(top) {
  const raw = top / 4;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw);
}

function ticks(n) {
  const step = Math.max(1, Math.ceil(n / 8));
  const out = [];
  for (let v = 0; v < n; v += step) out.push(v);
  return out;
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function svgElement(markup) {
  return new DOMParser().parseFromString(markup, "image/svg+xml").documentElement;
}

/** Fills `section` with the chart and the table; `onVolume(v)` shows volume v. */
export function renderMotionReport(section, summary, { onVolume }) {
  const replaced = summary.filter((row) => row.outlierSlices.length);
  const slices = replaced.reduce((sum, row) => sum + row.outlierSlices.length, 0);
  const worst = summary.reduce((max, row) => Math.max(max, Number.isFinite(row.rms) ? row.rms : 0), 0);
  const lead = element("p", {
    className: "nd-report-lead",
    textContent: `Largest displacement ${worst.toFixed(2)} mm. ${slices} outlier slice${slices === 1 ? "" : "s"} replaced in ${replaced.length} volume${replaced.length === 1 ? "" : "s"}. Select a volume to view it.`,
  });
  const legend = element("ul", { className: "nd-chart-legend" }, [
    element("li", { textContent: "Solid: RMS displacement from the reference (mm)" }),
    element("li", { textContent: "Dotted: from the previous volume" }),
    element("li", { textContent: "Dots: volumes with replaced slices" }),
  ]);
  const figure = element("figure", { className: "nd-chart-figure" }, [svgElement(displacementChart(summary))]);
  const table = element("table", { className: "nd-data-table" });
  const header = table.createTHead().insertRow();
  for (const label of ["Volume", "x mm", "y mm", "z mm", "x°", "y°", "z°", "RMS mm", "Replaced slices"]) {
    header.append(element("th", { textContent: label }));
  }
  const body = table.createTBody();
  for (const row of summary) {
    const tr = body.insertRow();
    if (row.outlierSlices.length) tr.dataset.flag = "outliers";
    tr.setAttribute("role", "button");
    tr.tabIndex = 0;
    tr.title = `Show volume ${row.volume + 1}`;
    const cells = [row.volume + 1, ...row.translation.map((t) => t.toFixed(2)), ...row.rotationDegrees.map((r) => r.toFixed(2)), Number.isFinite(row.rms) ? row.rms.toFixed(2) : "", row.outlierSlices.join(", ")];
    cells.forEach((value, k) => {
      const cell = tr.insertCell();
      cell.textContent = String(value);
      if (k < cells.length - 1) cell.className = "nd-numeric";
    });
    const open = () => onVolume(row.volume);
    tr.onclick = open;
    tr.onkeydown = (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    };
  }
  const scroll = element("div", { className: "nd-table-scroll" }, [table]);
  section.replaceChildren(lead, legend, figure, scroll);
}
