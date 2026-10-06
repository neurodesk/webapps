import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

const source = (...parts) => readFile(join(repoRoot, ...parts), 'utf8');
const exists = async (...parts) => access(join(repoRoot, ...parts)).then(() => true, () => false);
const execFileAsync = promisify(execFile);
const inferenceApps = ['calmar', 'musclemap', 'seedseg', 'spinalcordtoolbox', 'vesselboost'];

function topLevelCssRules(css) {
  return new Set([...css.matchAll(/^(?!\s|@)([^{}\n][^{]*)\{([^{}]*)\}/gm)].map((match) => (
    `${match[1].trim().replace(/\s+/g, ' ')}\0${match[2].trim().replace(/\s+/g, ' ')}`
  )));
}

test('the workspace and static pages expose one typed shell-control contract', async () => {
  const declarations = await source('packages', 'components', 'src', 'core', 'mountImagingWorkspace.d.ts');
  assert.match(declarations, /controlsContract\?:\s*ShellControlsContract/);
  assert.match(declarations, /ShellTargetSet/);
  assert.match(declarations, /'standalone'/);

  for (const app of inferenceApps) {
    const html = await source('apps', app, 'web', 'index.html');
    for (const action of ['about', 'cite', 'privacy']) {
      assert.match(html, new RegExp(`data-neurodesk-control=["']${action}["']`), `${app}/${action}`);
    }
  }

  const qsm = await source('apps', 'qsmbly', 'index.html');
  for (const action of ['about', 'cite', 'privacy']) {
    assert.match(qsm, new RegExp(`data-neurodesk-control=["']${action}["']`), `qsmbly/${action}`);
  }
  assert.match(qsm, /data-neurodesk-shell-link=["']more-apps["']/);
  assert.match(qsm, /data-neurodesk-shell-link=["']github["']/);

  const theme = await source('site', 'app-theme.css');
  assert.doesNotMatch(theme, /href\*?=["'][^"']*qsmbly|QSMbly|QSMxT/i);
});

test('shared styles have scoped entrypoints and no pairwise app duplicates', async () => {
  const base = await source('packages', 'components', 'src', 'styles', 'base.css');
  assert.doesNotMatch(base, /--color-|--space-|--radius-|--shadow-|--transition-/);
  await source('packages', 'components', 'src', 'styles', 'inference-workspace.css');
  const imaging = await source('packages', 'components', 'src', 'styles', 'imaging-workspace.css');
  assert.match(imaging, /\.nd-imaging-controls\s*>\s*\.row[\s\S]*?flex:\s*0 0 auto/);

  const sheets = await Promise.all(inferenceApps.map(async (app) => ({
    app,
    rules: topLevelCssRules(await source('apps', app, 'web', 'css', 'styles.css')),
  })));
  const duplicates = [];
  for (let left = 0; left < sheets.length; left += 1) {
    for (let right = left + 1; right < sheets.length; right += 1) {
      for (const rule of sheets[left].rules) {
        if (sheets[right].rules.has(rule)) duplicates.push(`${sheets[left].app}/${sheets[right].app}: ${rule.split('\0')[0]}`);
      }
    }
  }
  assert.deepEqual(duplicates, []);
});

test('all ORT workers use shared input and thread policy', async () => {
  for (const app of inferenceApps) {
    const worker = await source('apps', app, 'web', 'js', 'inference-worker.js');
    assert.match(worker, /getOptimalWasmThreads/);
    assert.doesNotMatch(worker, /function\s+getOptimalWasmThreads\s*\(/);
    assert.doesNotMatch(worker, /navigator\.hardwareConcurrency/);
  }
  for (const app of ['calmar', 'spinalcordtoolbox', 'vesselboost']) {
    const worker = await source('apps', app, 'web', 'js', 'inference-worker.js');
    assert.match(worker, /prepareRasWorkerInput/);
    assert.doesNotMatch(worker, /function\s+loadStateFromInput\s*\(/);
  }
});

test('QSM uses the shared worker plumbing without exposing a raw worker', async () => {
  const worker = await source('apps', 'qsmbly', 'js', 'qsm-worker-pure.js');
  assert.match(worker, /createWorkerEmitter/);
  assert.match(worker, /installWorkerRouter/);
  assert.doesNotMatch(worker, /self\.onmessage\s*=/);

  const app = await source('apps', 'qsmbly', 'js', 'qsm-app-romeo.js');
  assert.doesNotMatch(app, /getWorker\(\)\.postMessage|\.pipelineRunning\s*=/);
});

test('typed imaging runtimes use their declared shared or pinned owner', async () => {
  const runtimePackage = JSON.parse(await source('packages', 'runtime-support', 'package.json'));
  assert.equal(runtimePackage.exports['./dcm2niix-client'], './src/dcm2niix-client/index.ts');
  assert.equal(runtimePackage.exports['./niimath'].default, './src/niimath/index.js');

  for (const app of ['browserqc', 'deface']) {
    const packageJson = JSON.parse(await source('apps', app, 'package.json'));
    assert.equal(packageJson.dependencies['@neurodesk/runtime-support'], 'workspace:*');
    const main = await source('apps', app, 'src', 'main.ts');
    assert.match(main, /@neurodesk\/runtime-support\/dcm2niix-client/);
    assert.equal(await exists('apps', app, 'src', 'dcm2niix'), false);
    assert.equal(await exists('apps', app, 'src', 'niimath'), false);
  }

  const browserPackage = JSON.parse(await source('apps', 'browserqc', 'package.json'));
  const browserMain = await source('apps', 'browserqc', 'src', 'main.ts');
  assert.equal(browserPackage.dependencies['@niivue/niimath'], '1.4.20260909');
  assert.match(browserMain, /from ['"]@niivue\/niimath['"]/);

  const defaceMain = await source('apps', 'deface', 'src', 'main.ts');
  assert.match(defaceMain, /@neurodesk\/runtime-support\/niimath/);
});

test('the reusable convergence audit is wired into the repository test suite', async () => {
  const packageJson = JSON.parse(await source('package.json'));
  assert.match(packageJson.scripts['audit:convergence'], /audit-shared-imaging/);
  await source('scripts', 'audit-shared-imaging.mjs');
  await execFileAsync(process.execPath, ['scripts/audit-shared-imaging.mjs'], { cwd: repoRoot });
});
