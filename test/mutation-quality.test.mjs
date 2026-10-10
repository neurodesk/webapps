import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import config from '../stryker.config.mjs';
import { runMutations, summarizeMutations } from '../scripts/report-mutations.mjs';

const target = 'packages/nii2tvx/src/disconnectome.js';
const report = (statuses) => ({ files: { [target]: { mutants: statuses.map((status) => ({ status, location: { start: { line: 11 } }, mutatorName: 'StringLiteral', replacement: '""' })) } } });

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'mutation-quality-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'mutation-canary', private: true, type: 'module' }));
  for (const path of ['packages/nii2tvx/src', 'packages/nii2tvx/test']) mkdirSync(join(cwd, path), { recursive: true });
  cpSync(target, join(cwd, target));
  cpSync('packages/nii2tvx/test/disconnectome.test.js', join(cwd, 'packages/nii2tvx/test/disconnectome.test.js'));
  writeFileSync(join(cwd, 'packages/nii2tvx/package.json'), '{"type":"module"}');
  return cwd;
}

test('the pilot mutates one helper and invokes only its data-free Node test suite', () => {
  assert.deepEqual(config.mutate, [target]);
  assert.equal(config.commandRunner.command, 'node --test packages/nii2tvx/test/disconnectome.test.js');
  assert.equal(config.testRunner, 'command');
  assert.equal(config.coverageAnalysis, 'off');
  assert.equal(config.thresholds.break, null);
  assert.equal(config.cleanTempDir, 'always');
});

test('surviving mutations are reported without a score gate', () => {
  const markdown = summarizeMutations(report(['Killed', 'Survived']));
  assert.match(markdown, /50.00%/);
  assert.match(markdown, /survived: 1/);
  assert.match(markdown, /StringLiteral/);
  assert.match(markdown, /Scores are report-only/);
});

test('smoke requires actual detection and reports cannot silently contain no mutants', () => {
  assert.throws(() => summarizeMutations(report(['Survived']), { smoke: true }), /did not detect/);
  assert.throws(() => summarizeMutations(report([])), /No mutations/);
  assert.throws(() => summarizeMutations({}), /mutation report/);
  assert.throws(() => summarizeMutations({ files: {} }), /only the pilot/);
  assert.throws(() => summarizeMutations(report(['RuntimeError'])), /runtime errors/);
  assert.throws(() => summarizeMutations(report(['wrong'])), /Invalid mutant status/);
});

test('invalid real Stryker configuration fails and leaves diagnostics', (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'bad.config.mjs'), 'export default { concurrency: -1 };\n');
  assert.throws(() => runMutations({ cwd, config: 'bad.config.mjs' }), /Stryker failed/);
  assert.match(readFileSync(join(cwd, 'quality-artifacts/mutations/stryker.log'), 'utf8'), /concurrency/);
});

test('a failing real baseline test fails instead of reporting a mutation score', (t) => {
  const cwd = fixture(t);
  const failing = { ...config, commandRunner: { command: 'node --test packages/nii2tvx/test/disconnectome.test.js' } };
  writeFileSync(join(cwd, 'bad.config.mjs'), `export default ${JSON.stringify(failing)};\n`);
  writeFileSync(join(cwd, 'packages/nii2tvx/test/disconnectome.test.js'), "import test from 'node:test'; test('baseline', () => { throw new Error('baseline failure canary'); });\n");
  assert.throws(() => runMutations({ cwd, config: 'bad.config.mjs' }), /Stryker failed/);
  assert.match(readFileSync(join(cwd, 'quality-artifacts/mutations/stryker.log'), 'utf8'), /initial test run|baseline failure canary/i);
});

test('a crashing tool and missing executable fail', (t) => {
  const cwd = fixture(t);
  assert.throws(() => runMutations({ cwd, prefix: ['-e', 'process.exit(2)', '--'] }), /Stryker failed with exit 2/);
  assert.throws(() => runMutations({ cwd, prefix: ['-e', 'process.exit(0)', '--'] }), /ENOENT/);
  assert.throws(() => runMutations({ cwd, executable: join(cwd, 'missing') }), /ENOENT/);
});
