// Compares two frozen port snapshots of polygon_point_clouds hulls (the
// production model's exes/samsrf/core/tests/matlab_polygon_snapping.json as
// PREVIOUS, the experimental model's matlab_polygon_snapping.experimental.json
// as CURRENT) with MATLAB's recorded
// hulls (one host of geometry-reference.json). Each case reports MATLAB's and
// both snapshots' area, centroid and hull vertices, the relative area and
// connective-field sigma (sqrt(area) / (2 sqrt(2 ln 2))) errors and the centroid
// shift relative to MATLAB's hull length. Evidence for review, not a gate.
//
//   node compare-polygon-snapshots.mjs GEOMETRY_HOST_DIR PREVIOUS.json CURRENT.json REPORT.json
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const [root, previousFile, currentFile, reportFile] = process.argv.slice(2);
assert.ok(reportFile, 'Usage: compare-polygon-snapshots.mjs GEOMETRY_HOST_DIR PREVIOUS.json CURRENT.json REPORT.json');

const recording = JSON.parse(fs.readFileSync(path.join(root, 'geometry.json'), 'utf8'));
const clouds = recording.cases.find(item => item.id === 'polygon_point_clouds');
const read = descriptor => {
  const bytes = fs.readFileSync(path.join(root, descriptor.file));
  return Array.from({ length: bytes.length / 8 }, (_, i) => bytes.readDoubleLE(8 * i));
};
const columns = (values, rows) => Array.from({ length: rows }, (_, i) => [values[i], values[rows + i]]);
const n = clouds.cases;
const estimate = read(clouds.estimate);
const hullCounts = read(clouds.hullCounts);
const hullRows = columns(read(clouds.hull), hullCounts.reduce((a, b) => a + b, 0));
const hulls = [];
for (let i = 0, offset = 0; i < n; offset += hullCounts[i], i++) hulls.push(hullRows.slice(offset, offset + hullCounts[i]));

const bits = value => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(value));
  return view.getFloat64(0);
};
const sigma = area => Math.sqrt(area) / (2 * Math.sqrt(2 * Math.log(2)));
const length = vertices => Math.max(0, ...vertices.flatMap(a => vertices.map(b => Math.hypot(a[0] - b[0], a[1] - b[1]))));

function describe(outcome, i) {
  if (!outcome) return 'matches MATLAB';
  const matlab = { area: estimate[2 * n + i], centroid: [estimate[i], estimate[n + i]] };
  if (outcome.empty) return { empty: true };
  const area = bits(outcome.area);
  const centroid = outcome.centroid.map(bits);
  const hull = outcome.hull.map(pair => pair.map(bits));
  return {
    hullVertices: hull.length,
    area,
    centroid,
    areaRelativeError: (area - matlab.area) / matlab.area,
    sigmaRelativeError: (sigma(area) - sigma(matlab.area)) / sigma(matlab.area),
    centroidShiftPerHullLength: Math.hypot(centroid[0] - matlab.centroid[0], centroid[1] - matlab.centroid[1]) / length(hulls[i]),
  };
}

const previous = JSON.parse(fs.readFileSync(previousFile, 'utf8')).outcomes;
const current = JSON.parse(fs.readFileSync(currentFile, 'utf8')).outcomes;
const ids = [...new Set([...Object.keys(previous), ...Object.keys(current)])].map(Number).sort((a, b) => a - b);
const cases = ids.map(i => {
  const key = String(i);
  const status = previous[key] && current[key]
    ? (JSON.stringify(previous[key]) === JSON.stringify(current[key]) ? 'carried, unchanged' : 'carried, changed')
    : previous[key] ? 'resolved' : 'newly differs';
  return {
    case: i,
    status,
    matlab: { hullVertices: hulls[i].length, area: estimate[2 * n + i], centroid: [estimate[i], estimate[n + i]], hullLength: length(hulls[i]) },
    previous: describe(previous[key], i),
    current: describe(current[key], i),
  };
});
const summary = {};
for (const item of cases) summary[item.status] = (summary[item.status] ?? 0) + 1;
fs.writeFileSync(reportFile, `${JSON.stringify({ summary, cases }, null, 1)}\n`);
console.log(summary);
