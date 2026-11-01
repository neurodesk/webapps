import assert from 'node:assert/strict';
import fs, { existsSync, readdirSync, readFileSync } from 'node:fs';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { matchesGlob, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Pipeline builder's build generates its tool catalog from every app's automation
// contract and version. Record what that generation loads and reads, so the
// turbo inputs below can be held to it.
const root = fileURLToPath(new URL('..', import.meta.url));
const reads = new Set();
const record = (path) => {
  const file = relative(root, path instanceof URL ? fileURLToPath(path) : String(path)).split(sep).join('/');
  if (!file.startsWith('..') && !file.includes('node_modules/')) reads.add(file);
};
registerHooks({
  load(url, context, nextLoad) {
    if (url.startsWith('file:')) record(new URL(url));
    return nextLoad(url, context);
  },
});
const { readFile } = fs.promises;
fs.promises.readFile = (path, ...rest) => {
  record(path);
  return readFile(path, ...rest);
};
syncBuiltinESMExports();

const { loadCatalogContracts, neuroflowBundleFiles } = await import('../scripts/lib/neuroflow-bundle.mjs');
const { tools } = await neuroflowBundleFiles(await loadCatalogContracts({ exclude: ['pipeline-builder'] }));
const catalogReads = [...reads].sort();

const app = new URL('../apps/pipeline-builder/', import.meta.url);
const template = JSON.parse(readFileSync(new URL('src/workflows/t1-segmentation.workflow.json', app), 'utf8'));

test('the shipped template validates against the catalog generated from every app contract', async () => {
  const { createValidator } = await import('../apps/pipeline-builder/src/validator.js');
  const validate = await createValidator(tools, readFileSync(new URL('vendor/neuroflow/neuroflow_wasm_bg.wasm', app)));
  const result = validate(template);
  assert.equal(result.ok, true, JSON.stringify(result.issues));
  // A single volume fills N4's array input (NeuroFlow single-to-array rule).
  assert.ok(!result.issues.some((issue) => issue.path === 'steps.n4.inputs.input_image'));
  const broken = structuredClone(template);
  broken.steps.segment.inputs.input_image = { ref: 'steps.n4.outputs.report' };
  assert.ok(validate(broken).issues.some((issue) => issue.severity === 'error' && issue.path === 'steps.segment.inputs.input_image'));
});

test('the Pipeline builder build hash covers every file its tool catalog reads', () => {
  assert.ok(catalogReads.includes('registry/apps.yml') && catalogReads.includes('apps/n4/automation.json'), catalogReads.join('\n'));
  const turbo = JSON.parse(readFileSync(new URL('../turbo.json', import.meta.url), 'utf8'));
  const inputs = turbo.tasks['pipeline-builder#build'].inputs
    .filter((input) => input.startsWith('$TURBO_ROOT$/'))
    .map((input) => input.slice('$TURBO_ROOT$/'.length));
  // Turbo hashes the app's own files and those of its workspace dependencies.
  const manifest = JSON.parse(readFileSync(new URL('package.json', app), 'utf8'));
  const packageDirs = new Map(readdirSync(new URL('../packages/', import.meta.url))
    .filter((dir) => existsSync(new URL(`../packages/${dir}/package.json`, import.meta.url)))
    .map((dir) => [JSON.parse(readFileSync(new URL(`../packages/${dir}/package.json`, import.meta.url), 'utf8')).name, `packages/${dir}/`]));
  const workspaces = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, spec]) => spec.startsWith('workspace:'))
    .map(([name]) => packageDirs.get(name));
  assert.ok(workspaces.includes('packages/desktop/'), 'the generator runs from @neurodesk/desktop, so declare it');
  const hashed = (file) => ['apps/pipeline-builder/', ...workspaces].some((dir) => file.startsWith(dir))
    || [...turbo.globalDependencies, ...inputs].some((glob) => matchesGlob(file, glob));
  assert.deepEqual(catalogReads.filter((file) => !hashed(file)), [], 'add these to pipeline-builder#build inputs in turbo.json');
});
