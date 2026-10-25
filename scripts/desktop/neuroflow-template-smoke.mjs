import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { inventoryFiles, fileHash, verifyBundle } from '../../packages/desktop/src/bundle.js';
import { openDesktop } from '../../packages/desktop/neuroflow/runtime/stdio.mjs';
import { parseWorkflow, serializeWorkflow } from '../../apps/pipeline-builder/src/model.js';
import { neuroflowBundleFiles } from '../lib/neuroflow-bundle.mjs';
import { inspectScientificImage } from '../lib/scientific-output-checks.mjs';
import { decodeNiftiBuffer, parseNiftiHeader } from '../../packages/components/src/file-io/NiftiUtils.js';
import { MAX_BUFFER_BYTES, planInputMemory } from '../../packages/synthseg/src/input-memory.js';
import { compareIndividualApps } from '../lib/neuroflow-parity.mjs';
import { validationPlan } from '../lib/neuroflow-validation.mjs';

const root = resolve(import.meta.dirname, '../..');
const name = process.argv.includes('--dwi') ? 'dwi' : 't1';
const template = name === 'dwi' ? 'dwi-preprocessing' : 't1-segmentation';
const originalWorkflow = parseWorkflow(await readFile(join(root, `apps/pipeline-builder/src/workflows/${template}.workflow.json`), 'utf8'));
const diagnosticModels = process.argv.includes('--diagnostic-models');
assert.ok(!diagnosticModels || name === 'dwi', 'Models diagnostics require --dwi');
const plan = validationPlan(originalWorkflow, { diagnosticModels });
const { workflow } = plan;
const executable = process.env.NEUROFLOW_MCP_BIN;
assert.ok(executable, 'Set NEUROFLOW_MCP_BIN to the pinned upstream neuroflow-mcp executable');
assert.equal(process.env.NEURODESK_HARDWARE_GPU, '1', 'Exported scientific templates need a hardware WebGPU adapter');
const evidenceRoot = process.env.NEUROFLOW_EVIDENCE_DIR || tmpdir();
await mkdir(evidenceRoot, { recursive: true });
const scratch = await mkdtemp(join(evidenceRoot, `neuroflow-${name}-`));
console.log(`${template} integration evidence: ${scratch}`);
const bundle = join(scratch, 'desktop');
const cache = process.env.NEURODESK_ASSET_CACHE || join(tmpdir(), 'neurodesk-neuroflow-assets');
const ids = [...new Set(Object.values(workflow.steps).map(step => step.tool.split('/')[1]))];
const contracts = [];
await mkdir(join(bundle, 'site'), { recursive: true });
for (const id of ids) {
  await cp(join(root, 'apps', id, 'dist'), join(bundle, 'site', id), { recursive: true });
  contracts.push(JSON.parse(await readFile(join(root, 'apps', id, 'dist/automation.json'))));
}
await writeFile(join(bundle, 'site/index.html'), '<!doctype html><title>NeuroFlow scientific verification</title>');
async function stripAnalytics(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await stripAnalytics(path);
    else if (entry.name.endsWith('.html')) {
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(/<script\b[^>]*src=["'][^"']*(?:cloudflareinsights|googletagmanager)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, ''));
    } else if (entry.name === 'analytics.js') {
      await writeFile(path, 'export function initAnalytics() { return { enabled: false }; }');
    }
  }
}
await stripAnalytics(join(bundle, 'site'));
const sources = JSON.parse(await readFile(join(root, 'registry/offline-assets.sources.json')));
const lock = JSON.parse(await readFile(join(root, 'registry/offline-assets.lock.json')));
const built = new Map(Object.values(sources.apps).flat().filter(source => source.path).map(source => [source.url, source]));
const assets = {};
await mkdir(join(bundle, 'assets'), { recursive: true });
await mkdir(cache, { recursive: true });
async function stageAsset(url) {
  if (assets[url]) return;
  const source = built.get(url);
  if (source) {
    const path = join(root, source.path);
    const sha256 = await fileHash(path);
    assets[url] = { path: `assets/${sha256}`, sha256, bytes: (await stat(path)).size, kind: source.kind, contentType: source.contentType };
    await cp(path, join(bundle, assets[url].path));
    return;
  }
  const record = lock.assets[url];
  assert.ok(record, `Unpinned offline asset: ${url}`);
  const path = join(cache, record.sha256);
  const valid = await stat(path).then(async details => details.size === record.bytes && await fileHash(path) === record.sha256, () => false);
  if (!valid) {
    const response = await fetch(url, { signal: AbortSignal.timeout(600000) });
    assert.ok(response.ok, `${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, record.bytes, `Asset size: ${url}`);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), record.sha256, `Asset hash: ${url}`);
    await writeFile(path, bytes);
  }
  assets[url] = { ...record, path: `assets/${record.sha256}` };
  await cp(path, join(bundle, assets[url].path));
  for (const dependency of record.dependencies || []) await stageAsset(dependency);
}
for (const id of ids) {
  for (const url of lock.apps[id]) await stageAsset(url);
}
const { version } = JSON.parse(await readFile(join(root, 'packages/desktop/package.json')));
await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version, defaultApp: null,
  apps: ids.map(id => ({ id, path: id, title: id })), assets, files: await inventoryFiles(bundle) }));
await verifyBundle(bundle);
const registry = join(scratch, 'registry');
const { files, tools } = await neuroflowBundleFiles(contracts);
for (const [name, bytes] of files) {
  const path = join(registry, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}
await writeFile(join(scratch, 'exported.workflow.json'), serializeWorkflow(workflow));
let inputs;
let dataRoot;
if (name === 'dwi') {
  const examples = JSON.parse(await readFile(join(root, 'apps/dwicorrect/examples.json')));
  const example = examples.find(entry => entry.id === 'ds006676-s3p1');
  assert.ok(example, 'The DWI template needs its pinned multi-shell AP/PA example');
  const select = (role, direction) => {
    const file = example.files.find(entry => entry.role === role && entry.name.includes(`_dir-${direction}_`));
    assert.ok(file, `Missing ${direction} ${role}`);
    return file;
  };
  const files = {
    dwi: select('image', 'AP'), bval: select('bval', 'AP'), bvec: select('bvec', 'AP'),
    sidecar: select('sidecar', 'AP'), reverse: select('image', 'PA'), reverseSidecar: select('sidecar', 'PA'),
  };
  dataRoot = join(scratch, 'inputs');
  await mkdir(dataRoot, { recursive: true });
  inputs = {};
  for (const [role, file] of Object.entries(files)) {
    await stageAsset(file.url);
    const path = join(dataRoot, file.name);
    await cp(join(bundle, assets[file.url].path), path);
    inputs[role] = path;
  }
} else {
  // Use SynthSeg's validated whole-head example, retaining its complete physical field of view.
  const examples = JSON.parse(await readFile(join(root, 'apps/synthseg/examples.json')));
  const fixture = examples.find(example => example.id === 't1-head')?.files.find(file => file.role === 'image');
  assert.ok(fixture, 'The T1 template needs the pinned SynthSeg whole-head example');
  await stageAsset(fixture.url);
  dataRoot = join(scratch, 'inputs');
  await mkdir(dataRoot, { recursive: true });
  const path = join(dataRoot, fixture.name);
  await cp(join(bundle, assets[fixture.url].path), path);
  const header = parseNiftiHeader(await decodeNiftiBuffer(await readFile(path)));
  const plan = planInputMemory(header);
  assert.ok(plan.requiredBufferBytes <= MAX_BUFFER_BYTES,
    `The whole-head T1 fixture must fit SynthSeg at 1 mm: padded ${plan.paddedShape.join('×')}, ${plan.requiredBufferBytes} buffer bytes`);
  inputs = { t1: path };
}
const require = createRequire(join(root, 'packages/desktop/package.json'));
const env = { ...process.env, NEURODESK_BUNDLE: bundle, NEURODESK_USER_DATA: join(scratch, 'profile'),
  NEURODESK_WEBAPPS: require('electron'), NEURODESK_SOFTWARE_RENDERING: '0',
  NEURODESK_WEBAPPS_ARGS: JSON.stringify([join(root, 'packages/desktop')]), NEURODESK_TIMEOUT_MS: name === 'dwi' ? '7200000' : '2400000' };
delete env.ELECTRON_RUN_AS_NODE;
const client = openDesktop(executable, ['--registry', registry, '--data-root', dataRoot,
  '--sessions', join(scratch, 'sessions'), '--step-timeout', name === 'dwi' ? '7300' : '2500'], { env });
try {
  await client.initialize();
  const completed = await client.tool('neuroflow_run', { workflow, inputs }, { timeoutMs: name === 'dwi' ? 18000000 : 7800000 });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const runDirectory = join(scratch, 'sessions', completed.runId);
  const run = JSON.parse(await readFile(join(runDirectory, 'run.json')));
  assert.equal(run.qualifierInspectors.enforcement, 'before-consumer-launch');
  const entries = await readdir(runDirectory, { recursive: true });
  const results = {};
  for (const id of Object.keys(workflow.steps)) {
    assert.equal(run.steps[id].status, 'completed', `${id} completed its actual scientific operation`);
    const resultFile = entries.find(name => name.replaceAll('\\', '/').endsWith(`outputs/${id}/result.json`));
    assert.ok(resultFile, `${id} wrote its result`);
    const result = JSON.parse(await readFile(join(runDirectory, resultFile)));
    const report = JSON.parse(await readFile(result.report));
    assert.equal(report.status, 'succeeded', `${id} provenance reports successful execution`);
    for (const [role, artifact] of Object.entries(report.artifacts)) {
      const paths = [result[`output_${role}`]].flat().filter(Boolean);
      if (!paths.length) continue;
      const records = [artifact].flat();
      for (const [index, path] of paths.entries()) {
        assert.equal(await fileHash(path), records[index].sha256, `${id}.${role} matches its scientific report`);
      }
    }
    results[id] = result;
    if (name === 'dwi' && id === 'tractography') {
      assert.ok(report.measurements.streamlines > 0 && report.measurements.points > 0, 'Real tractography produced streamlines');
      assert.equal(report.measurements.partial, false, 'The tractogram was not truncated');
    }
  }
  for (const [name, declaration] of Object.entries(workflow.outputs)) {
    assert.equal(typeof completed.outputs[name]?.uri, 'string', `Workflow output ${name} is available`);
    const [, id, , role] = declaration.ref.split('.');
    const bytes = await readFile(results[id][role]);
    assert.ok(bytes.length > 0, `${name} contains output bytes`);
    if (!['neuro:volume', 'neuro:mask', 'neuro:label-map'].includes(declaration.type)) continue;
    await inspectScientificImage(bytes, declaration.type);
  }
  const comparisons = name === 'dwi' ? await compareIndividualApps({ workflow: plan.comparisons, inputs, results, tools, scratch, env }) : undefined;
  await writeFile(join(scratch, 'evidence.json'), JSON.stringify({ passed: true, diagnosticModels, fullWorkflowAcceptance: plan.fullWorkflowAcceptance, workflow, completed, run, comparisons }, null, 2));
  console.log(`${diagnosticModels ? 'Diagnostic models replay (not full workflow acceptance)' : `Exported ${template} workflow completed every real scientific operation`}. Evidence: ${scratch}`);
} finally {
  await client.close();
}
