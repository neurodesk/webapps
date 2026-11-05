// The Morphometrics and Sholl tabs: tables and a shared .nd-chart, drawn in place of the canvas.
import { MORPHOMETRIC_COLUMNS } from "./morph/outputs.js";

const WIDTH = 640;
const HEIGHT = 220;
const MARGIN = { left: 34, right: 10, top: 8, bottom: 30 };
const TYPE_HEADINGS = { all: "All neurites", axon: "Axon", basal: "Basal", apical: "Apical" };
const round = (value) => Math.round(value * 10) / 10;
const format = (value) => (value == null ? "–" : Number.isInteger(value) ? String(value) : value.toFixed(value >= 100 ? 1 : 2));

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function niceStep(top, ticks = 4) {
  const raw = top / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 5, 10].map((m) => m * power).find((step) => step >= raw);
}

function table(head, rows, caption) {
  const node = element("table", { className: "nd-data-table" });
  if (caption) node.createCaption().textContent = caption;
  const header = node.createTHead().insertRow();
  for (const label of head) header.append(element("th", { textContent: label }));
  const body = node.createTBody();
  for (const row of rows) {
    const tr = body.insertRow();
    row.forEach((value, k) => {
      const cell = tr.insertCell();
      cell.textContent = typeof value === "number" || value == null ? format(value) : value;
      if (k > 0) cell.className = "nd-numeric";
    });
  }
  return element("div", { className: "nd-table-scroll" }, [node]);
}

/** The SVG of Sholl intersections against radius for all neurites. */
export function shollChart({ radii, crossings }) {
  const values = crossings.all;
  const xTop = radii.at(-1) ?? 1;
  const yTop = Math.max(1, ...values);
  const xStep = niceStep(xTop, 6);
  const yStep = Math.max(1, niceStep(yTop));
  const yCeiling = Math.ceil(yTop / yStep) * yStep;
  const right = WIDTH - MARGIN.right;
  const bottom = HEIGHT - MARGIN.bottom;
  const x = (r) => round(MARGIN.left + ((right - MARGIN.left) * r) / xTop);
  const y = (n) => round(bottom - ((bottom - MARGIN.top) * n) / yCeiling);
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" class="nd-chart" viewBox="0 0 ${WIDTH} ${HEIGHT}" role="img" aria-label="Sholl intersections against radius">`];
  for (let n = 0; n <= yCeiling; n += yStep) {
    parts.push(`<line class="nd-chart-gridline" x1="${MARGIN.left}" x2="${right}" y1="${y(n)}" y2="${y(n)}"/>`);
    parts.push(`<text x="${MARGIN.left - 4}" y="${y(n) + 3}" text-anchor="end">${n}</text>`);
  }
  parts.push(`<line class="nd-chart-axis" x1="${MARGIN.left}" x2="${right}" y1="${bottom}" y2="${bottom}"/>`);
  for (let r = 0; r <= xTop + 1e-9; r += xStep) parts.push(`<text x="${x(r)}" y="${bottom + 12}" text-anchor="middle">${Number(r.toFixed(3))}</text>`);
  parts.push(`<text x="${round((MARGIN.left + right) / 2)}" y="${HEIGHT - 2}" text-anchor="middle">Radius from the soma centre (µm)</text>`);
  const points = [`${x(0)},${y(0)}`, ...radii.map((r, k) => `${x(r)},${y(values[k])}`)];
  parts.push(`<polyline class="nd-chart-median" points="${points.join(" ")}"/>`);
  parts.push("</svg>");
  return parts.join("");
}

/** Fills `section` with the checks and the morphometrics of one neuron. */
export function renderMorphometricsReport(section, neuron) {
  const types = Object.keys(TYPE_HEADINGS).filter((type) => type === "all" || neuron.analysis.features[type].neurites);
  const rows = MORPHOMETRIC_COLUMNS.map(([, label, get]) => [label, ...types.map((type) => get(neuron.analysis.features[type]))]);
  const all = neuron.analysis.features.all;
  const lead = element("p", {
    className: "nd-report-lead",
    textContent: `${neuron.name}: ${all.neurites} neurites, ${format(all.totalLength)} µm total length, ${all.bifurcations} bifurcations.`,
  });
  const checks = neuron.issues.length
    ? table(["Check", "Lines"], neuron.issues.map((issue) => [`${issue.repaired ? "Repaired: " : ""}${issue.message}`, issue.lines.slice(0, 5).join(", ") + (issue.lines.length > 5 ? ", …" : "")]), "SWC checks")
    : element("p", { textContent: "SWC checks: no issues found." });
  const notes = element("div", { className: "nd-report-notes" }, [
    element("p", { textContent: "Definitions follow NeuroM 4: lengths exclude the soma and the gap from the soma to each neurite; angles are measured at bifurcations with exactly two branches." }),
  ]);
  section.replaceChildren(lead, table(["Measure", ...types.map((type) => TYPE_HEADINGS[type])], rows, "Morphometrics"), checks, notes);
}

/** Fills `section` with the Sholl profile of one neuron. */
export function renderShollReport(section, neuron) {
  const { sholl } = neuron.analysis;
  const peak = Math.max(0, ...sholl.crossings.all);
  const at = sholl.radii[sholl.crossings.all.indexOf(peak)];
  const lead = element("p", {
    className: "nd-report-lead",
    textContent: peak ? `${neuron.name}: at most ${peak} intersections, at ${format(at)} µm (step ${format(sholl.step)} µm).` : `${neuron.name}: no intersections at a ${format(sholl.step)} µm step.`,
  });
  const figure = element("figure", { className: "nd-chart-figure" });
  figure.append(new DOMParser().parseFromString(shollChart(sholl), "image/svg+xml").documentElement);
  const types = Object.keys(TYPE_HEADINGS).filter((type) => type === "all" || neuron.analysis.features[type].neurites);
  const rows = sholl.radii.map((radius, k) => [format(radius), ...types.map((type) => sholl.crossings[type][k])]);
  section.replaceChildren(lead, figure, table(["Radius (µm)", ...types.map((type) => TYPE_HEADINGS[type])], rows, "Intersections per radius"));
}
