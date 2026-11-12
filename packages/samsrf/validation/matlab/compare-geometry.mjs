// Inventory and same-host determinism of a MATLAB geometry recording
// (record_geometry.m). Source-to-source evidence only, never port parity.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GEOMETRY_INVENTORY = { 'polygon-batch': 7, delaunay: 168, cluster: 72, 'template-cf': 12 };
// record_geometry(..., 'polyshape-probe'): the focused polyshape probes alone.
export const PROBE_CASES = ['probe_grid_sweep', 'probe_grid_bisection', 'probe_heldout_collinear', 'probe_heldout_clouds', 'probe_extreme_grids', 'probe_point_clouds'];
// record_geometry(..., 'polyshape-causal'): polyshape_causal_cases.m's families.
export const CAUSAL_CASES = ['causal_gap_sweep', 'causal_gap_bisection', 'causal_hole_contact', 'causal_real', 'causal_heldout'];
export const CAUSAL_POLYGONS = { causal_gap_sweep: 8424, causal_hole_contact: 170, causal_heldout: 600 };
export const PROBE_POLYGONS = { probe_grid_sweep: 24120, probe_heldout_collinear: 1500, probe_heldout_clouds: 1500, probe_extreme_grids: 7, probe_point_clouds: 2500 };

export function validateGeometry(root) {
  const recording = JSON.parse(fs.readFileSync(path.join(root, 'geometry.json'), 'utf8'));
  const counts = {};
  for (const item of recording.cases) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  const probe = recording.mode === 'polyshape-probe' || recording.mode === 'polyshape-causal';
  if (recording.mode === 'polyshape-causal') {
    assert.deepEqual(recording.cases.map(item => item.id), CAUSAL_CASES, 'Incomplete polyshape causal recording');
    for (const [id, cases] of Object.entries(CAUSAL_POLYGONS)) {
      assert.equal(recording.cases.find(item => item.id === id).cases, cases, `${id}: polygon count`);
    }
    assert.equal(recording.cases.find(item => item.id === 'causal_gap_bisection').parameters.shape[0], 36, 'causal_gap_bisection: combinations');
    for (const item of recording.cases) {
      for (const field of ['collinearVertices', 'defaultHoles', 'keptHoles', 'fromKept', 'fromDefault', 'viaSimplify']) assert.ok(item[field], `${item.id}: missing ${field}`);
    }
    const environment = JSON.parse(fs.readFileSync(path.join(root, 'environment.json'), 'utf8'));
    assert.equal(environment.mode, 'polyshape-causal', 'Causal provenance does not name its mode');
  } else if (probe) {
    assert.deepEqual(recording.cases.map(item => item.id), PROBE_CASES, 'Incomplete polyshape probe recording');
    for (const [id, cases] of Object.entries(PROBE_POLYGONS)) {
      assert.equal(recording.cases.find(item => item.id === id).cases, cases, `${id}: polygon count`);
    }
    const environment = JSON.parse(fs.readFileSync(path.join(root, 'environment.json'), 'utf8'));
    assert.equal(environment.mode, 'polyshape-probe', 'Probe provenance does not name its mode');
  } else {
    assert.equal(recording.mode, undefined, `Unknown geometry mode ${recording.mode}`);
    assert.deepEqual(counts, GEOMETRY_INVENTORY, 'Incomplete geometry recording');
  }
  assert.equal(new Set(recording.cases.map(item => item.id)).size, recording.cases.length, 'Duplicate case IDs');
  const descriptors = [];
  const visit = value => {
    if (value && typeof value === 'object') {
      if (typeof value.file === 'string' && Array.isArray(value.shape)) descriptors.push(value);
      else for (const child of Object.values(value)) visit(child);
    }
  };
  visit(recording.cases);
  for (const descriptor of descriptors) {
    const bytes = fs.statSync(path.join(root, descriptor.file)).size;
    assert.equal(bytes, 8 * descriptor.shape.reduce((a, b) => a * b, 1), `${descriptor.file}: size differs from its shape`);
  }
  for (const hemisphere of probe ? [] : ['lh', 'rh']) {
    for (const precision of ['double', 'single']) {
      for (const mode of ['hull', 'summary', 'gaussian']) {
        const id = `template_${hemisphere}_${precision}_${mode}`;
        assert.ok(recording.cases.some(item => item.id === id), `Missing ${id}`);
      }
    }
  }
  return { recording, arrays: descriptors.length };
}

export function compareGeometry(first, second) {
  const a = validateGeometry(first);
  const b = validateGeometry(second);
  const environment = root => JSON.parse(fs.readFileSync(path.join(root, 'environment.json'), 'utf8'));
  const [ea, eb] = [environment(first), environment(second)];
  for (const key of ['matlab', 'computer', 'requested', 'observed', 'functions']) {
    assert.ok(ea[key] && eb[key], `Missing ${key} provenance`);
    assert.deepEqual(ea[key], eb[key], `Execution settings differ: ${key}`);
  }
  const files = root => fs.readdirSync(root).filter(name => name.endsWith('.f64')).sort();
  const names = files(first);
  assert.deepEqual(names, files(second), 'Recorded array inventories differ');
  const hash = (root, name) => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  const differences = names.filter(name => hash(first, name) !== hash(second, name));
  const metadataEqual = JSON.stringify(a.recording.cases) === JSON.stringify(b.recording.cases);
  return { cases: a.recording.cases.length, arrays: names.length, differences, metadataEqual, exact: !differences.length && metadataEqual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [first, second, reportFile] = process.argv.slice(2);
  assert.ok(first, 'Usage: compare-geometry.mjs RECORDING [REPEAT REPORT_JSON]');
  if (!second) {
    const { recording, arrays } = validateGeometry(first);
    console.log(`Complete geometry recording: ${recording.cases.length} cases, ${arrays} arrays.`);
  } else {
    const report = compareGeometry(first, second);
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
    assert.ok(report.exact, 'Geometry recordings differ; see the report.');
    console.log(`Exact repeat: ${report.cases} cases, ${report.arrays} arrays. Port parity is not asserted.`);
  }
}
