import { execFileSync } from 'node:child_process';
import { htmlEntries, publishedSourceEntries, sourceCoverage, validateLiteralEntries, validateProjectExclusions } from '../scripts/lib/unused-code-config.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    assert.ok(config.workspaces[name].project.includes('**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'), name);
    assert.ok(!config.workspaces[name].entry.some((entry) => entry === '**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}' || entry === 'src/**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'), name);
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

test('all tracked JavaScript and TypeScript files are covered or explicitly excluded', () => {
  const files = execFileSync('git', ['ls-files', '-z', '*.js', '*.mjs', '*.cjs', '*.jsx', '*.ts', '*.tsx', '*.mts', '*.cts'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  assert.deepEqual(files.filter((file) => !sourceCoverage(file, config.workspaces)), []);
  assert.equal(sourceCoverage('new-tools/unregistered-helper.js', config.workspaces), undefined);
  assert.equal(sourceCoverage('docs/new-live-helper.js', config.workspaces), undefined);
  assert.equal(sourceCoverage('config/dependency-quality.mjs', config.workspaces), 'covered');
  assert.equal(sourceCoverage('config/nested/policy.cts', config.workspaces), 'covered');
  assert.equal(sourceCoverage('new-config/policy.mjs', config.workspaces), undefined);
  assert.ok(!config.workspaces['.'].entry.some((entry) => entry.startsWith('config/')));
  assert.equal(sourceCoverage('apps/dicompare/src/new-module.mts', config.workspaces), 'covered');
  assert.equal(sourceCoverage('apps/dicompare/src/new-module.cts', config.workspaces), 'covered');
});

test('HTML roots handle static web roots, unquoted attributes and query strings', (t) => {
  const options = fixture(t);
  mkdirSync(join(options.cwd, 'web/js'), { recursive: true });
  writeFileSync(join(options.cwd, 'web/js/main.js'), 'console.log("main");');
  writeFileSync(join(options.cwd, 'web/index.html'), '<script type=module src=/js/main.js?v=1></script>');
  assert.deepEqual(htmlEntries(options.cwd), ['web/js/main.js']);
  writeFileSync(join(options.cwd, 'web/index.html'), '<script src=missing.js></script>');
  assert.throws(() => htmlEntries(options.cwd), /Missing local HTML script/);
  assert.deepEqual(htmlEntries(options.cwd, ['missing.js']), []);
  writeFileSync(join(options.cwd, 'web/missing.js'), 'console.log("staged runtime");');
  assert.deepEqual(htmlEntries(options.cwd, ['missing.js']), []);
});

test('public dist JavaScript exports map to TypeScript sources or fail loudly', (t) => {
  const options = fixture(t);
  mkdirSync(join(options.cwd, 'src'), { recursive: true });
  writeFileSync(join(options.cwd, 'src/index.ts'), 'export const publicApi = 1;');
  assert.deepEqual(publishedSourceEntries(options.cwd, { '.': { import: './dist/index.js' } }), ['src/index.ts']);
  assert.throws(() => publishedSourceEntries(options.cwd, './dist/missing.js'), /Missing source mapping/);
});

test('missing explicit runtime entries fail configuration validation', (t) => {
  const options = fixture(t);
  validateLiteralEntries(options.cwd, { '.': { entry: ['index.js', 'optional/**/*.js'] } });
  assert.throws(() => validateLiteralEntries(options.cwd, { '.': { entry: ['missing-worker.js'] } }), /Missing explicit entry/);
});

test('duplicate symbol groups and scan warnings appear in summaries', () => {
  const report = { issues: [{ file: 'module.js', files: [], exports: [], types: [], dependencies: [], devDependencies: [], duplicates: [[{ name: 'named', line: 1 }, { name: 'default', line: 2 }]] }] };
  const markdown = summarize(report, 'Warning: could not parse source.js\n');
  assert.match(markdown, /named, default/);
  assert.match(markdown, /Scan diagnostics \(1 lines/);
  assert.match(markdown, /could not parse source.js/);
});

test('relative report output resolves against the requested working directory', (t) => {
  const options = fixture(t);
  runReport({ ...options, output: 'relative-artifacts' });
  assert.match(readFileSync(join(options.cwd, 'relative-artifacts/summary.md'), 'utf8'), /deadExport/);
});

test('only documented project exclusions can satisfy source coverage', () => {
  validateProjectExclusions(config.workspaces);
  assert.throws(() => validateProjectExclusions({ 'apps/dicompare': { project: ['**/*.js', '!src/**'] } }), /Undocumented source exclusion/);
  assert.throws(() => validateProjectExclusions({ 'apps/dicompare': { project: ['**/*.js', '!niivue/**'] } }), /Undocumented source exclusion/);
});
