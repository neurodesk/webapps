import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { inventoryFiles, verifyBundle } from '../../packages/desktop/src/bundle.js';
import { openDesktop } from '../../packages/desktop/neuroflow/runtime/stdio.mjs';
import { readVolume } from '../../packages/synthsr/src/volume.js';

const executable = process.env.NEUROFLOW_MCP_BIN;
assert.ok(executable, 'Set NEUROFLOW_MCP_BIN to the upstream neuroflow-mcp executable');
const root = resolve(import.meta.dirname, '../..');
const scratch = await mkdtemp(join(tmpdir(), 'neuroflow-bet-'));
const bundle = join(scratch, 'desktop');
const dist = join(root, 'apps/brain-extraction/dist');
const fixture = join(root, 'apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz');
await mkdir(join(bundle, 'site'), { recursive: true });
await cp(dist, join(bundle, 'site/brain-extraction'), { recursive: true });
await writeFile(join(bundle, 'site/index.html'), '<!doctype html><title>NeuroFlow verification</title>');
async function removeAnalytics(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await removeAnalytics(path);
    else if (entry.name.endsWith('.html')) {
      const source = await readFile(path, 'utf8');
      await writeFile(path, source.replace(/<script\b[^>]*src=["'][^"']*(?:cloudflareinsights|googletagmanager)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, ''));
    } else if (entry.name === 'analytics.js') {
      await writeFile(path, 'export function initAnalytics() { return { enabled: false }; }');
    }
  }
}
await removeAnalytics(join(bundle, 'site'));
const desktopVersion = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'))).version;
await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: desktopVersion,
  defaultApp: null, apps: [{ id: 'brain-extraction', path: 'brain-extraction', title: 'Brain extraction' }],
  assets: {}, files: await inventoryFiles(bundle) }));
await verifyBundle(bundle);
const registry = join(scratch, 'registry');
await promisify(execFile)(process.execPath, [join(root, 'scripts/generate-neuroflow.mjs'),
  '--contract', join(dist, 'automation.json'), '--out', registry]);
const require = createRequire(join(root, 'packages/desktop/package.json'));
const env = { ...process.env, NEURODESK_BUNDLE: bundle, NEURODESK_USER_DATA: join(scratch, 'profile'),
  NEURODESK_SOFTWARE_RENDERING: '1', NEURODESK_WEBAPPS: require('electron'),
  NEURODESK_WEBAPPS_ARGS: JSON.stringify([...(process.env.NEURODESK_CONTAINER === '1' ? ['--no-sandbox'] : []), join(root, 'packages/desktop')]) };
delete env.ELECTRON_RUN_AS_NODE;
const client = openDesktop(executable, ['--registry', registry, '--data-root', dirname(fixture),
  '--sessions', join(scratch, 'sessions'), '--step-timeout', '240'], { env });
try {
  await client.initialize();
  const tool = 'neurodesk.webapps/brain-extraction/extract';
  const step = input => ({ tool, inputs: {
    input_image: { ref: input }, param_method: { constant: 'bet' },
    param_threshold: { constant: 0.5 }, engine: { constant: 'browser' },
  } });
  const workflow = {
    neuroflow: '0.1.1', kind: 'workflow', id: 'neurodesk.test/bet-chain',
    version: '1.0.0', description: 'Verify scalar chaining through two real BET executions',
    inputs: { image: { type: 'neuro:volume', description: 'T1 fixture', formats: ['nifti'] } },
    steps: { first: step('inputs.image'), second: step('steps.first.outputs.output_brain') },
    outputs: {
      output_mask: { type: 'neuro:mask', ref: 'steps.first.outputs.output_mask' },
      output_brain: { type: 'neuro:volume', ref: 'steps.second.outputs.output_brain' },
      report: { type: 'neuro:report', ref: 'steps.first.outputs.report' },
    },
  };
  const completed = await client.tool('neuroflow_run', { workflow, inputs: { image: fixture } }, { timeoutMs: 540000 });
  assert.equal(completed.status, 'completed', JSON.stringify(completed));
  const run = JSON.parse(await readFile(join(scratch, 'sessions', completed.runId, 'run.json')));
  assert.equal(run.qualifierInspectors.enforcement, 'before-consumer-launch');
  assert.equal(run.steps.first.status, 'completed');
  assert.equal(run.steps.second.status, 'completed');
  const checked = run.steps.second.qualifierChecks.find(item =>
    item.binding === 'steps.second.inputs.input_image');
  assert.equal(checked?.checks.find(check => check.qualifier === 'formats')?.outcome, 'compatible');
  assert.equal(checked.evidence.producer.step, 'first');
  assert.equal(typeof completed.outputs.output_mask.uri, 'string');
  assert.equal(typeof completed.outputs.output_brain.uri, 'string');
  const reportUri = `${completed.outputs.report.uri}/raw`;
  const reportResource = (await client.resource(reportUri)).contents[0];
  const report = JSON.parse(reportResource.text ?? Buffer.from(reportResource.blob, 'base64').toString('utf8'));
  const maskResource = (await client.resource(completed.outputs.output_mask.uri)).contents[0];
  const summary = JSON.parse(maskResource.text);
  // Read the verified local output rather than the runtime's size-limited raw resource.
  const resultFiles = await readdir(join(scratch, 'sessions', completed.runId), { recursive: true });
  const resultFile = resultFiles.find(name => /outputs\/first\/result\.json$/.test(name));
  assert.ok(resultFile, 'NeuroFlow result file exists');
  const result = JSON.parse(await readFile(join(scratch, 'sessions', completed.runId, resultFile)));
  const bytes = await readFile(result.output_mask);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), report.artifacts.mask.sha256);
  const image = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const original = await readFile(fixture);
  const input = readVolume(original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength));
  assert.deepEqual(image.dims, input.dims);
  assert.deepEqual(image.affine, input.affine);
  assert.ok(image.data.every(value => value === 0 || value === 1));
  const mask = Uint8Array.from(image.data);
  assert.equal(mask.reduce((sum, value) => sum + value, 0), 246875);
  assert.equal(createHash('sha256').update(mask).digest('hex'), '107a46c3a2f42f4a7796dc5a5b2a6660a302239ae50a0cf2eea80b1767a50862');
  await writeFile(join(scratch, 'evidence.json'), JSON.stringify({ passed: true, runId: completed.runId,
    workflow, report, artifactSummary: summary, consumerCheck: checked }, null, 2));
  console.log(`NeuroFlow → generated launcher → desktop MCP → real BET → real BET passed. Evidence: ${scratch}`);
} finally { await client.close(); }
