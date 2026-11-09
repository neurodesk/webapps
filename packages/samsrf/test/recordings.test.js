import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compareRecordings } from '../validation/matlab/compare-recordings.mjs';

test('same-host comparison requires every array and acceptance decision to repeat exactly', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'samsrf-repeats-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const first = path.join(root, 'first'), second = path.join(root, 'second');
  const metadata = {
    environment: { matlab: 'test', computer: 'test', requested: { threads: 1 }, observed: { threads: 1 } },
    cases: Object.entries({ 'css-coarse': 4, 'css-correlation': 10, glm: 146 })
      .flatMap(([kind, count]) => Array.from({ length: count }, (_, i) => ({ kind, id: `${kind}-${i}`, accepted: true }))),
  };
  for (const precision of ['single', 'double']) {
    for (const vertex of [15, 16, 17, 18, 22, 26, 47, 58, 60, 67, 69, 73, 74, 79, 81, 82, 88, 89]) {
      for (const control of ['nonnegative0_recorded', 'nonnegative0_recomputed', 'nonnegative1_recomputed']) {
        metadata.cases.push({ kind: 'css-trace', id: `css_pipeline_${precision}_v${vertex}_${control}`, accepted: true });
      }
    }
  }
  for (const directory of [first, second]) {
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'diagnostics.json'), JSON.stringify(metadata));
    fs.writeFileSync(path.join(directory, 'map.f64'), Buffer.from(new Float64Array([1, NaN, Infinity]).buffer));
  }
  assert.equal(compareRecordings(first, second).exact, true);
  const remaining = metadata.cases.find(item => item.id === 'css_pipeline_double_v60_nonnegative0_recorded');
  const originalId = remaining.id;
  remaining.id = 'css_pipeline_double_v61_nonnegative0_recorded';
  fs.writeFileSync(path.join(second, 'diagnostics.json'), JSON.stringify(metadata));
  assert.throws(() => compareRecordings(first, second), /Missing diagnostic trace: css_pipeline_double_v60/);
  remaining.id = originalId;
  fs.writeFileSync(path.join(second, 'diagnostics.json'), JSON.stringify(metadata));
  fs.writeFileSync(path.join(second, 'map.f64'), Buffer.from(new Float64Array([1, NaN, -Infinity]).buffer));
  assert.deepEqual(compareRecordings(first, second).differences, ['map.f64']);
  fs.copyFileSync(path.join(first, 'map.f64'), path.join(second, 'map.f64'));
  metadata.cases[0].accepted = false;
  fs.writeFileSync(path.join(second, 'diagnostics.json'), JSON.stringify(metadata));
  assert.equal(compareRecordings(first, second).metadataEqual, false);
  assert.equal(compareRecordings(first, second).exact, false);
  fs.unlinkSync(path.join(second, 'map.f64'));
  assert.throws(() => compareRecordings(first, second), /inventories differ/);
  metadata.cases.pop();
  fs.writeFileSync(path.join(second, 'diagnostics.json'), JSON.stringify(metadata));
  assert.throws(() => compareRecordings(first, second), /Incomplete diagnostic matrix/);
});
