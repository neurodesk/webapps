// Same-host determinism check. These are source-to-source comparisons, not port parity.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function compareRecordings(first, second) {
  const read = (root, name) => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
  const a = read(first, 'diagnostics.json');
  const b = read(second, 'diagnostics.json');
  assert.ok(!a.smoke && !b.smoke, 'Smoke recordings are not MATLAB references');
  assert.ok(a.cases?.length && b.cases?.length, 'Missing diagnostic cases');
  for (const recording of [a, b]) {
    const counts = {};
    for (const item of recording.cases) counts[item.kind] = (counts[item.kind] ?? 0) + 1;
    assert.deepEqual(counts, { 'css-coarse': 4, 'css-trace': 78, 'css-correlation': 10, glm: 146 }, 'Incomplete diagnostic matrix');
    assert.equal(new Set(recording.cases.map(item => item.id)).size, recording.cases.length, 'Duplicate case IDs');
  }
  for (const key of ['matlab', 'computer', 'requested', 'observed']) {
    assert.ok(a.environment?.[key] && b.environment?.[key], `Missing ${key} provenance`);
    assert.deepEqual(a.environment[key], b.environment[key], `Execution settings differ: ${key}`);
  }
  const files = root => fs.readdirSync(root).filter(name => name.endsWith('.f64')).sort();
  const names = files(first);
  assert.ok(names.length, 'No recorded numerical arrays');
  assert.deepEqual(names, files(second), 'Recorded array inventories differ');
  const hash = (root, name) => createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex');
  const differences = names.filter(name => hash(first, name) !== hash(second, name));
  const metadataEqual = JSON.stringify(a.cases) === JSON.stringify(b.cases);
  return { arrays: names.length, cases: a.cases.length, differences, metadataEqual, exact: !differences.length && metadataEqual };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [first, second, reportFile] = process.argv.slice(2);
  assert.ok(first && second && reportFile, 'Usage: compare-recordings.mjs FIRST SECOND REPORT_JSON');
  const report = compareRecordings(first, second);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2) + '\n');
  assert.ok(report.exact, 'Same-host recordings differ; see the report. This is not port-equivalence evidence.');
  console.log(`Exact same-host repeat: ${report.cases} cases, ${report.arrays} arrays. Port parity is not asserted.`);
}
