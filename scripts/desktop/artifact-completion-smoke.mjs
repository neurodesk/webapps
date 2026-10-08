import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
const root = resolve(import.meta.dirname, '../..');
const { parseContract } = await import(pathToFileURL(join(root, 'packages/desktop/src/contracts.js')));
const { inventoryFiles } = await import(pathToFileURL(join(root, 'packages/desktop/src/bundle.js')));
const scratch = await mkdtemp(join(tmpdir(), 'artifact-electron-'));
const require = createRequire(join(root, 'packages/desktop/package.json'));
const executable = process.env.NEURODESK_ELECTRON || require('electron');
const contract = parseContract({ schemaVersion: 2, app: 'completion', appVersion: '0.1.20261003', title: 'Completion fixture', description: 'Exercise desktop completion.',
  defaultOperation: 'run', operations: { run: { title: 'Run', description: 'Produce a controlled artifact.', mode: 'viewer', engines: ['browser'], inputs: {},
    parameters: { mode: { type: 'string', description: 'Fixture behavior', enum: ['ok', 'offline', 'late-offline', 'viewer-missing', 'waiting'], default: 'ok' } },
    artifacts: { result: { type: 'file:text', mediaType: 'text/plain', minimum: 1, maximum: 1 } },
  } } });
const html = `<!doctype html><title>Completion fixture</title><button id="download">Download</button><button id="offline">Offline</button><span id="statusText"></span><script>
const contract = ${JSON.stringify(contract)};
const bytes = new TextEncoder().encode('controlled scientific artifact');
let report, state = 'ready', parameters;
function save(filename, data, type) {
  const url = URL.createObjectURL(new Blob([data], {type}));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function missing() { await fetch('https://absent.invalid/asset').catch(() => {}); }
document.querySelector('#download').onclick = () => save('result.txt', bytes, 'text/plain');
document.querySelector('#offline').onclick = async () => { await missing(); document.querySelector('#statusText').textContent = 'ready'; };
globalThis.neurodeskAutomation = { async dispatch(command, args = {}) {
  if (command === 'describe') return contract;
  if (command === 'start') {
    parameters = args.parameters;
    if (parameters.mode === 'offline') await missing();
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(v => v.toString(16).padStart(2, '0')).join('');
    report = { schemaVersion: 2, app: contract.app, appVersion: contract.appVersion, operation: 'run', runId: 'fixture-run', status: 'succeeded', inputs: {}, parameters,
      summary: { source: 'controlled fixture' }, artifacts: { output7: { role: 'result', type: 'file:text', mediaType: 'text/plain', filename: 'result.txt', bytes: bytes.length, sha256: digest } } };
    state = parameters.mode === 'waiting' ? 'running' : 'succeeded';
    return { runId: 'fixture-run' };
  }
  if (command === 'snapshot') return { runId: 'fixture-run', state, message: parameters.mode === 'waiting' ? 'waiting' : 'complete', ...(state === 'succeeded' && {report}) };
  if (command === 'download') return args.artifactId === 'report' ? save('report.json', JSON.stringify(report), 'application/json') : save('result.txt', bytes, 'text/plain');
  if (command === 'viewers.list') {
    if (parameters.mode === 'late-offline') await missing();
    return parameters.mode === 'viewer-missing' ? [] : [{ id: 'image', title: 'Image', capabilities: { crosshair: false } }];
  }
  if (command === 'viewers.state') return { source: 'controlled fixture' };
} };
</script>`;
const bundle = join(scratch, 'bundle');
await mkdir(join(bundle, 'site/completion'), { recursive: true });
await writeFile(join(bundle, 'site/index.html'), '<!doctype html><title>Fixture</title>');
await writeFile(join(bundle, 'site/completion/index.html'), html);
await writeFile(join(bundle, 'site/completion/automation.json'), JSON.stringify(contract));
await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version: '0.19.20260930', defaultApp: 'completion', assets: {},
  apps: [{ id: 'completion', path: 'completion', title: 'Completion fixture' }], files: await inventoryFiles(bundle) }));
const evidence = [];
function launch(args, profile) {
  const env = { ...process.env, NEURODESK_BUNDLE: bundle, NEURODESK_USER_DATA: join(scratch, profile), NEURODESK_SOFTWARE_RENDERING: '1' };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NEURODESK_MODELS_DIR;
  return spawn(executable, ['--no-sandbox', join(root, 'packages/desktop'), ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function cli(schema, mode) {
  const output = join(scratch, `cli-${schema}-${mode}`);
  const job = schema === 1 ? { schemaVersion: 1, app: 'completion', expectedDownloads: 1, timeoutMs: 20000,
    steps: [{ action: 'click', selector: '#download' }, ...(mode === 'offline' ? [
      { action: 'click', selector: '#offline' }, { action: 'wait', selector: '#statusText', condition: 'text', value: 'ready' },
    ] : [])] } : { schemaVersion: 2, app: 'completion', automation: { contract }, request: { inputs: {}, parameters: { mode }, retainViewer: false, timeoutMs: 20000 } };
  const path = join(scratch, `job-${schema}-${mode}.json`);
  await writeFile(path, JSON.stringify(job));
  const child = launch(['--job', path, '--output', output], `profile-${schema}-${mode}`);
  let stderr = '', stdout = '';
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', data => { stdout += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  assert.equal(code, mode === 'offline' ? 1 : 0, stderr);
  assert.equal(await readFile(join(output, 'result.txt'), 'utf8'), 'controlled scientific artifact');
  if (mode === 'offline') {
    assert.match(stderr, /absent from the offline package/);
    await assert.rejects(readFile(join(output, 'job-result.json')), { code: 'ENOENT' });
    await assert.rejects(readFile(join(output, '.job-result.json.partial')), { code: 'ENOENT' });
  } else {
    assert.deepEqual(JSON.parse(await readFile(join(output, 'job-result.json'))), JSON.parse(stdout.trim()));
  }
  evidence.push({ caller: 'CLI', schema, mode, passed: true });
}
function connect() {
  const outputRoot = join(scratch, 'mcp');
  const child = launch(['--mcp', '--output', outputRoot], 'profile-mcp');
  const pending = new Map();
  let nextId = 0, stderr = '';
  child.stderr.on('data', data => { stderr += data; });
  const exited = new Promise(resolve => child.once('close', resolve));
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    const request = pending.get(message.id);
    if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message); }
  });
  async function request(method, params = {}) {
    const id = ++nextId;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP ${method} timed out: ${stderr}`)), 30000);
      pending.set(id, { resolve, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    return response.result;
  }
  async function tool(name, args = {}) {
    const response = await request('tools/call', { name, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response.content));
    return response.structuredContent;
  }
  return { child, exited, request, tool, outputRoot, diagnostics: () => stderr };
}
let client;
try {
  for (const schema of [1, 2]) for (const mode of ['ok', 'offline']) await cli(schema, mode);
  client = connect();
  await client.request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'completion-smoke', version: '1.0.0' } });
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  for (const mode of ['late-offline', 'viewer-missing', 'waiting', 'ok']) {
    const started = await client.tool('runs_start', { app: 'completion', parameters: { mode }, timeoutMs: 20000 });
    let run;
    for (let i = 0; i < 300; i++) {
      run = await client.tool('runs_get', { runId: started.id });
      if (run.state !== 'running' || (mode === 'waiting' && run.message === 'waiting')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    if (mode === 'waiting') run = await client.tool('runs_cancel', { runId: started.id });
    assert.equal(run.state, mode === 'ok' ? 'succeeded' : mode === 'waiting' ? 'cancelled' : 'failed', JSON.stringify(run) + '\n' + client.diagnostics());
    const output = join(client.outputRoot, started.id, 'outputs');
    const { sessions } = await client.tool('sessions_list');
    if (mode === 'ok') {
      const report = JSON.parse(await readFile(join(output, 'job-result.json')));
      assert.equal(report.runId, 'fixture-run');
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].id, run.session.id);
      assert.equal((await client.tool('runs_cancel', { runId: started.id })).state, 'succeeded');
      await client.tool('viewers_state', { sessionId: run.session.id, viewerId: 'image' });
      await client.tool('sessions_close', { sessionId: run.session.id });
      assert.equal(JSON.parse(await readFile(join(output, 'job-result.json'))).runId, 'fixture-run');
    } else {
      assert.deepEqual(sessions, []);
      await assert.rejects(readFile(join(output, 'job-result.json')), { code: 'ENOENT' });
      for (let i = 0; i < 100; i++) {
        try { await stat(output); } catch (error) { if (error.code === 'ENOENT') break; throw error; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      await assert.rejects(stat(output), { code: 'ENOENT' });
      if (mode === 'late-offline') assert.match(run.error.message, /absent from the offline package/);
      if (mode === 'viewer-missing') assert.match(run.error.message, /did not register a viewer/);
    }
    evidence.push({ caller: 'MCP', schema: 2, mode, passed: true });
  }
  client.child.stdin.end();
  assert.equal(await client.exited, 0, client.diagnostics());
  if (process.env.NEURODESK_TEST_REPORT) {
    await mkdir(process.env.NEURODESK_TEST_REPORT, { recursive: true });
    await writeFile(join(process.env.NEURODESK_TEST_REPORT, 'artifact-completion-smoke.json'), JSON.stringify({ passed: true, evidence }, null, 2) + '\n');
  }
  console.log(JSON.stringify({ passed: true, evidence }));
} finally {
  if (client?.child.exitCode === null) { client.child.kill('SIGKILL'); await client.exited; }
  await rm(scratch, { recursive: true, force: true });
}
