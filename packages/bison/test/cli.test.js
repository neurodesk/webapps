// The bison command line's arguments, without running the pipeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/bison.js', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

test('--help names both modes and the outputs', () => {
  const result = run('--help');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--t1 T1\.nii\[\.gz\] \[--flair FLAIR\.nii\[\.gz\]\] --output DIR/);
  assert.match(result.stdout, /_bison-labels\.nii\.gz/);
});

test('a run without --t1 or --output is refused', () => {
  for (const args of [['--output', 'out'], ['--t1', 't1.nii.gz']]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Give --t1 and --output/);
  }
});

test('an unknown command is refused', () => {
  const result = run('segment');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command "segment"/);
});

test('self-check and download-models take no positional arguments', () => {
  assert.match(run('self-check', 'x').stderr, /does not accept arguments/);
  assert.match(run('download-models', 'x').stderr, /does not accept positional arguments/);
});
