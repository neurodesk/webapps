// Inventory and same-host determinism of a MATLAB geometry recording
// (record_geometry.m). Source-to-source evidence only, never port parity.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const GEOMETRY_INVENTORY = { 'polygon-batch': 7, delaunay: 168, cluster: 72, 'template-cf': 12 };

export function validateGeometry(root) {
  const recording = JSON.parse(fs.readFileSync(path.join(root, 'geometry.json'), 'utf8'));
  const counts = {};
  for (const item of recording.cases) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
  assert.deepEqual(counts, GEOMETRY_INVENTORY, 'Incomplete geometry recording');
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
  for (const hemisphere of ['lh', 'rh']) {
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
