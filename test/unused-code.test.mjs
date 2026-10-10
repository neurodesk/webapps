import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { getPackages } from '@manypkg/get-packages';
import config from '../knip.config.mjs';
import { runReport, summarize } from '../scripts/report-unused-code.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'unused-code-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'canary', private: true, type: 'module' }));
  writeFileSync(join(directory, 'knip.json'), JSON.stringify({ entry: ['index.js'], project: ['*.js'], include: ['files', 'exports', 'types', 'duplicates', 'dependencies', 'devDependencies'], includeEntryExports: true }));
  writeFileSync(join(directory, 'index.js'), "import { live } from './helper.js'; console.log(live);\n");
  writeFileSync(join(directory, 'helper.js'), 'export const live = 1; export const deadExport = 2;\n');
  writeFileSync(join(directory, 'dead.js'), 'console.log("unused file canary");\n');
  return { cwd: directory, config: 'knip.json', output: join(directory, 'artifacts'), summary: join(directory, 'summary.md') };
}

test('every pnpm workspace receives a source project without treating all sources as entries', async () => {
  const { packages } = await getPackages(process.cwd());
  for (const pkg of packages) {
    const name = relative(process.cwd(), pkg.dir).replaceAll('\\', '/');
    assert.ok(config.workspaces[name], name);
    assert.ok(config.workspaces[name].project.includes('**/*.{js,mjs,cjs,jsx,ts,tsx}'), name);
    assert.ok(!config.workspaces[name].entry.some((entry) => entry === '**/*.{js,mjs,cjs,jsx,ts,tsx}' || entry === 'src/**/*.{js,mjs,cjs,jsx,ts,tsx}'), name);
  }
});

test('real Knip detects a dead file and export while report-only findings succeed', (t) => {
  const options = fixture(t);
  runReport(options);
  const report = JSON.parse(readFileSync(join(options.output, 'knip.json'), 'utf8'));
  assert.ok(report.issues.some((issue) => issue.file === 'dead.js' && issue.files.length));
  assert.ok(report.issues.some((issue) => issue.exports.some((item) => item.name === 'deadExport')));
  assert.match(readFileSync(options.summary, 'utf8'), /deadExport/);
  assert.doesNotMatch(readFileSync(options.summary, 'utf8'), /\| live \|/);
});

test('invalid configuration fails rather than becoming a successful report', (t) => {
  const options = fixture(t);
  writeFileSync(join(options.cwd, 'knip.json'), '{ invalid JSON');
  assert.throws(() => runReport(options), /Knip failed/);
  assert.match(readFileSync(join(options.output, 'diagnostics.log'), 'utf8'), /ERROR/);
});

test('runtime configuration load errors fail even when Knip emits findings', (t) => {
  const options = fixture(t);
  writeFileSync(join(options.cwd, 'vite.config.js'), "throw new Error('config load canary');\n");
  writeFileSync(join(options.cwd, 'knip.json'), JSON.stringify({ entry: ['index.js'], project: ['*.js'], vite: true }));
  assert.throws(() => runReport(options), /Knip failed/);
  assert.match(readFileSync(join(options.output, 'diagnostics.log'), 'utf8'), /config load canary/);
});

test('crashes fail even if stdout contains valid findings', (t) => {
  const options = fixture(t);
  assert.throws(() => runReport({ ...options, prefix: ['-e', 'console.log(JSON.stringify({issues: []})); process.exit(2);', '--'] }), /Knip failed with exit 2/);
});

test('missing executables and malformed successful output fail', (t) => {
  const options = fixture(t);
  assert.throws(() => runReport({ ...options, executable: join(options.cwd, 'missing') }), /ENOENT/);
  assert.throws(() => runReport({ ...options, prefix: ['-e', 'console.log("not json")', '--'] }), /JSON/);
  assert.throws(() => summarize({}), /expected JSON report/);
});
