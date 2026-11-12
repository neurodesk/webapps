import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { inventoryFiles, verifyBundle } from '../../packages/desktop/src/bundle.js';
import { readVolume } from '../../packages/synthsr/src/volume.js';

const root = resolve(import.meta.dirname, '../..');
const fixture = join(root, 'apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz');
const synthsegFixture = join(root, 'exes/synthseg/test/fixtures/small.nii.gz');
const appIds = ['brain-extraction', 'synthseg'];
const scratch = await mkdtemp(join(tmpdir(), 'neurodesk-automation-smoke-'));
const evidence = process.env.NEURODESK_TEST_REPORT;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const volume = bytes => readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
// Set by the https hosts' /session/ paths. A viewer sends it back; no other viewer, and no later launch, may.
const cookieName = `smoke${randomBytes(6).toString('hex')}`;
const summary = { passed: false, protocolVersion: '2025-11-25', apps: appIds, synthsegInference: 'Not run; this check exercises scientific BET processing.' };

async function disableAnalytics(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await disableAnalytics(path);
    else if (entry.name.endsWith('.html')) {
      const html = await readFile(path, 'utf8');
      await writeFile(path, html.replace(/<script\b[^>]*src=["'][^"']*(?:cloudflareinsights|googletagmanager)[^"']*["'][^>]*>[\s\S]*?<\/script>/gi, ''));
    } else if (entry.name === 'analytics.js') {
      await writeFile(path, 'export function initAnalytics() { return { enabled: false, reason: "offline" }; }\n');
    }
  }
}

async function focusedBundle() {
  const bundle = join(scratch, 'bundle');
  await mkdir(join(bundle, 'site'), { recursive: true });
  const apps = [];
  for (const id of appIds) {
    const dist = join(root, 'apps', id, 'dist');
    const contract = JSON.parse(await readFile(join(dist, 'automation.json'), 'utf8'));
    await cp(dist, join(bundle, 'site', id), { recursive: true });
    apps.push({ id, path: id, title: contract.title });
  }
  await writeFile(join(bundle, 'site/index.html'), '<!doctype html><title>Automation verification</title>\n');
  await disableAnalytics(join(bundle, 'site'));
  const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'), 'utf8')).version;
  const files = await inventoryFiles(bundle);
  await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ schemaVersion: 1, version, defaultApp: null, apps, assets: {}, files }));
  summary.bundle = await verifyBundle(bundle);
  return bundle;
}

// A remote image host on another loopback port. Only /approved/ is pre-approved, and its redirect leads out of it.
// Over https, a path under /session/ sets the cookie, and each request's cookie is recorded.
async function remoteHost(tls) {
  const image = await readFile(fixture);
  const hits = [];
  const cookies = [];
  const handler = (request, response) => {
    hits.push(request.url);
    cookies.push([request.url, request.headers.cookie ?? '']);
    const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
    if (request.url.includes('/session/')) headers['Set-Cookie'] = `${cookieName}=1; Path=/; Secure; SameSite=None; Max-Age=86400`;
    if (request.url === '/approved/redirect.nii.gz') response.writeHead(302, { ...headers, Location: '/outside/T1.nii.gz' }).end();
    else if (request.url.endsWith('/T1.nii.gz')) response.writeHead(200, { ...headers, 'Content-Type': 'application/gzip', 'Content-Length': image.length }).end(image);
    else response.writeHead(404, headers).end();
  };
  const server = tls ? createSecureServer(tls, handler) : createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  /** Whether the requests for `path` carried the cookie; the path must have been requested. */
  const sentCookie = path => {
    const sent = cookies.filter(([url]) => url === path);
    assert.ok(sent.length, `${path} was requested`);
    return sent.some(([, cookie]) => cookie.includes(cookieName));
  };
  return { origin: `${tls ? 'https' : 'http'}://127.0.0.1:${server.address().port}`, hits, sentCookie, close: () => server.close() };
}

// A throwaway self-signed certificate. The desktop starts with --ignore-certificate-errors, so its name does not matter.
async function testCertificate() {
  const key = join(scratch, 'tls-key.pem');
  const cert = join(scratch, 'tls-cert.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { encoding: 'utf8' });
  assert.equal(made.status, 0, `openssl could not make a test certificate: ${made.error?.message ?? made.stderr}`);
  return { key: await readFile(key), cert: await readFile(cert) };
}

function connect(bundle, { remote, secure, compute }) {
  const require = createRequire(join(root, 'packages/desktop/package.json'));
  const executable = process.env.NEURODESK_EXECUTABLE || require('electron');
  const env = {
    ...process.env,
    NEURODESK_BUNDLE: bundle,
    NEURODESK_USER_DATA: join(scratch, 'profile'),
    NEURODESK_SOFTWARE_RENDERING: process.env.NEURODESK_SOFTWARE_RENDERING || '1',
    // Run outputs and each remote host's /approved/ are pre-approved for agent loading; no one is there to approve
    // anything else.
    NEURODESK_APPROVED_SOURCES: [join(scratch, 'runs'), ...[remote, secure, compute].map(host => `${host.origin}/approved/`)].join(','),
    NEURODESK_SOURCE_APPROVAL: 'deny',
    NEURODESK_COMPUTE_ORIGINS: compute.origin,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NEURODESK_MODELS_DIR;
  const args = [
    ...(process.env.NEURODESK_CONTAINER === '1' ? ['--no-sandbox'] : []),
    ...(process.env.NEURODESK_EXECUTABLE ? [] : [join(root, 'packages/desktop')]),
    '--mcp', '--output', join(scratch, 'runs'), '--ignore-certificate-errors',
  ];
  const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let nextId = 0;
  let stderr = Buffer.alloc(0);
  let failure;
  let closed = false;
  let messages = 0;
  const fail = error => {
    failure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  child.stderr.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(-65536); });
  child.once('error', fail);
  child.stdin.on('error', fail);
  const exited = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true;
    if (pending.size) fail(new Error(`Desktop exited with ${code ?? signal}: ${stderr.toString('utf8')}`));
    resolve({ code, signal });
  }));
  createInterface({ input: child.stdout }).on('line', line => {
    try {
      const message = JSON.parse(line);
      assert.equal(message.jsonrpc, '2.0', 'Desktop stdout must contain only JSON-RPC');
      assert.ok('result' in message || 'error' in message || typeof message.method === 'string');
      ++messages;
      if (pending.has(message.id)) {
        pending.get(message.id).resolve(message);
        pending.delete(message.id);
      }
    } catch (error) {
      fail(new Error(`Non-protocol desktop stdout: ${line.slice(0, 240)}`, { cause: error }));
    }
  });
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure || closed) {
      reject(failure || new Error('Desktop connection is closed'));
      return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Desktop timed out answering ${method}: ${stderr.toString('utf8')}`));
    }, 60000);
    pending.set(id, {
      resolve(value) {
        clearTimeout(timer);
        resolve(value);
      },
      reject(error) {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  return {
    request,
    async call(method, params) {
      const response = await request(method, params);
      assert.equal(response.error, undefined, JSON.stringify(response.error));
      return response.result;
    },
    async tool(name, args = {}) {
      const response = await this.call('tools/call', { name, arguments: args });
      assert.notEqual(response.isError, true, JSON.stringify(response.content));
      return response.structuredContent;
    },
    notify(method) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`);
    },
    diagnostics() {
      return stderr.toString('utf8');
    },
    async end() {
      child.stdin.end();
      let timer;
      try {
        const status = await Promise.race([
          exited,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Desktop did not exit after stdin closed')), 15000); }),
        ]);
        if (failure) throw failure;
        assert.equal(status.code, 0, `Desktop exited ${status.code ?? status.signal}: ${stderr.toString('utf8')}`);
        return { ...status, messages };
      } finally {
        clearTimeout(timer);
      }
    },
    async dispose() {
      if (!closed) {
        child.kill('SIGKILL');
        await exited;
      }
    },
  };
}

async function start(bundle, hosts) {
  const started = connect(bundle, hosts);
  const initialized = await started.call('initialize', {
    protocolVersion: summary.protocolVersion,
    capabilities: {},
    clientInfo: { name: 'neurodesk-production-smoke', version: '1.0.0' },
  });
  assert.equal(initialized.protocolVersion, summary.protocolVersion);
  started.notify('notifications/initialized');
  return started;
}

async function waitForRun(client, id) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    const snapshot = await client.tool('runs_get', { runId: id });
    if (snapshot.state !== 'running') return snapshot;
    await delay(250);
  }
  throw new Error(`BET run ${id} did not complete in five minutes`);
}

let client;
let remote;
let secure;
let compute;
try {
  const bundle = await focusedBundle();
  remote = await remoteHost();
  const tls = await testCertificate();
  secure = await remoteHost(tls);
  compute = await remoteHost(tls);
  summary.hosts = { remote: remote.origin, secure: secure.origin, compute: compute.origin };
  client = await start(bundle, { remote, secure, compute });
  const tools = (await client.call('tools/list')).tools;
  assert.ok(tools.every(tool => /^[A-Za-z0-9_-]{1,64}$/.test(tool.name)), 'MCP tools must have portable names');
  for (const name of ['run_brain_extraction', 'run_synthseg']) {
    const tool = tools.find(tool => tool.name === name);
    assert.ok(tool, `Missing generated tool: ${name}`);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.equal(tool.inputSchema.properties.inputs.additionalProperties, false);
  }
  const contracts = (await client.tool('apps_list')).apps;
  assert.deepEqual(contracts.map(contract => contract.app).sort(), appIds);
  for (const app of appIds) {
    await client.tool('apps_validate', { app, inputs: { image: [app === 'synthseg' ? synthsegFixture : fixture] } });
  }
  for (const name of ['apps_validate', 'runs_start']) {
    const oversized = await client.call('tools/call', {
      name,
      arguments: { app: 'synthseg', inputs: { image: [fixture] } },
    });
    assert.equal(oversized.isError, true);
    assert.match(oversized.content[0].text, /padded to 224×256×192.*above the validated 2 GiB limit/);
  }
  summary.preflight = { synthsegSmall: 'accepted', oversizedValidation: 'rejected', oversizedStart: 'rejected' };
  const invalid = await client.call('tools/call', {
    name: 'apps_validate',
    arguments: { app: 'brain-extraction', inputs: { image: [join(scratch, 'missing.nii')] } },
  });
  assert.equal(invalid.isError, true);
  const request = { inputs: { image: [fixture] }, parameters: { method: 'bet', threshold: 0.5 }, timeoutMs: 300000, retainViewer: true };
  const abandoned = await client.tool('run_brain_extraction', request);
  const cancelled = await client.tool('runs_cancel', { runId: abandoned.id });
  assert.equal(cancelled.state, 'cancelled');
  assert.equal(cancelled.report, undefined);
  assert.deepEqual((await client.call('resources/list')).resources, []);

  const started = await client.tool('run_brain_extraction', request);
  const finished = await waitForRun(client, started.id);
  assert.equal(finished.state, 'succeeded', JSON.stringify(finished.error));
  const reportResource = await client.call('resources/read', { uri: finished.reportUri });
  const report = JSON.parse(reportResource.contents[0].text);
  assert.equal(report.status, 'succeeded');
  assert.equal(report.app, 'brain-extraction');
  assert.equal(report.inputs.image[0].sha256, hash(await readFile(fixture)));
  const artifacts = {};
  for (const [role, descriptor] of Object.entries(report.artifacts)) {
    const uri = `neurodesk://runs/${started.id}/artifacts/${role}`;
    const resource = (await client.call('resources/read', { uri })).contents[0];
    const bytes = resource.blob ? Buffer.from(resource.blob, 'base64') : Buffer.from(resource.text);
    assert.equal(bytes.length, descriptor.bytes, `${role} byte count`);
    assert.equal(hash(bytes), descriptor.sha256, `${role} checksum`);
    artifacts[role] = bytes;
  }
  const original = volume(await readFile(fixture));
  const brain = volume(artifacts.brain);
  const mask = volume(artifacts.mask);
  assert.deepEqual(mask.dims, original.dims);
  assert.deepEqual(mask.affine, original.affine);
  assert.deepEqual(brain.affine, original.affine);
  assert.ok(mask.data.every(value => value === 0 || value === 1));
  const binary = Uint8Array.from(mask.data);
  const voxelCount = binary.reduce((sum, value) => sum + value, 0);
  const maskSha256 = hash(binary);
  // Golden values are pinned by apps/brain-extraction/e2e/app.spec.js.
  assert.equal(voxelCount, 240631);
  assert.equal(maskSha256, '20112e75bdaab6c8f3d9d47469b6814554f167996f4cff61e004f00207b233ad');
  assert.ok(brain.data.every((value, index) => value === (binary[index] ? original.data[index] : 0)));
  assert.equal(JSON.parse(artifacts.report).runId, report.runId);
  const sessionId = finished.session.id;
  const sessions = await client.tool('sessions_list');
  assert.equal(sessions.sessions[0].runId, finished.id);
  const { viewers } = await client.tool('viewers_list', { sessionId });
  assert.equal(viewers[0].capabilities.crosshair, true);
  const voxel = mask.dims.map(size => Math.floor(size * 0.4));
  const mm = mask.affine.slice(0, 3).map(row => row[0] * voxel[0] + row[1] * voxel[1] + row[2] * voxel[2] + row[3]);
  const position = await client.tool('viewers_crosshair', { sessionId, viewerId: viewers[0].id, position: { frame: 'mm', value: mm } });
  position.position.value.forEach((value, axis) => assert.ok(Math.abs(value - mm[axis]) < 1e-3));
  const tab = await client.tool('viewers_tab', { sessionId, viewerId: viewers[0].id, tabId: 'mask' });
  assert.equal(tab.tabs.find(entry => entry.id === 'mask').active, true);
  const regions = viewers[0].capabilities.regions
    ? await client.tool('viewers_regions', { sessionId, viewerId: viewers[0].id }) : { supported: false };
  assert.deepEqual([viewers[0].capabilities.volumes, viewers[0].capabilities.display, viewers[0].capabilities.screenshot], [true, true, true]);
  const { volumes } = await client.tool('viewers_volumes', { sessionId, viewerId: viewers[0].id });
  assert.ok(volumes.length > 0);
  async function screenshot() {
    const shot = await client.call('tools/call', { name: 'viewers_screenshot', arguments: { sessionId, viewerId: viewers[0].id } });
    assert.notEqual(shot.isError, true, JSON.stringify(shot.content));
    const [image] = shot.content;
    assert.equal(image.type, 'image');
    assert.equal(image.mimeType, 'image/png');
    const png = Buffer.from(image.data, 'base64');
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
    assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [shot.structuredContent.width, shot.structuredContent.height]);
    assert.ok(shot.structuredContent.width > 0 && shot.structuredContent.height > 0);
    return { ...shot.structuredContent, sha256: hash(png) };
  }
  const before = await screenshot();
  const display = await client.tool('viewers_display', { sessionId, viewerId: viewers[0].id, sliceType: 'axial',
    volumes: [{ index: 0, colormap: 'hot', calMin: volumes[0].calMin, calMax: volumes[0].calMax }] });
  assert.equal(display.sliceType, 'axial');
  assert.equal(display.volumes[0].colormap, 'hot');
  const after = await screenshot();
  assert.notEqual(after.sha256, before.sha256, 'the screenshot must show the display change, not a stale frame');
  summary.viewer = { viewers, position, regions, volumes, display: { sliceType: display.sliceType }, screenshots: [before, after] };

  // nv-mcp's tools reach the same retained viewer as a tab named by its session ID.
  assert.equal(viewers[0].capabilities.niivue, true);
  async function niivue(name, args = {}) {
    const response = await client.call('tools/call', { name, arguments: args });
    assert.notEqual(response.isError, true, `${name}: ${JSON.stringify(response.content)}`);
    const text = response.content.find(part => part.type === 'text')?.text ?? '';
    return { response, text, json: text.includes('{') ? JSON.parse(text.slice(text.indexOf('{'))) : null };
  }
  const findMm = value => (value && typeof value === 'object'
    ? (Array.isArray(value.mm) && value.mm.length === 3 ? value.mm : Object.values(value).map(findMm).find(Boolean)) : undefined);
  const tabs = await niivue('list_tabs');
  assert.match(tabs.text, new RegExp(sessionId));
  const target = mm.map(value => value + 2);
  await niivue('go_to_point', { mm: target });
  const here = await niivue('where_am_i');
  const reported = findMm(here.json);
  assert.ok(reported, here.text);
  // NiiVue snaps the crosshair to the nearest voxel centre.
  reported.forEach((value, axis) => assert.ok(Math.abs(value - target[axis]) <= 1, `${value} vs ${target[axis]}`));
  await niivue('set_view', { slice: 'coronal' });
  const shot = await niivue('screenshot');
  const image = shot.response.content.find(part => part.type === 'image');
  assert.equal(image?.mimeType, 'image/png');
  const png = Buffer.from(image.data, 'base64');
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  const nvShot = { width: png.readUInt32BE(16), height: png.readUInt32BE(20), sha256: hash(png) };
  assert.notEqual(nvShot.sha256, after.sha256, 'the nv-mcp screenshot must show the coronal view');
  const maskPath = join(scratch, 'runs', started.id, 'outputs', report.artifacts.mask.filename);
  const layers = async () => (await client.tool('viewers_volumes', { sessionId, viewerId: viewers[0].id })).volumes.length;
  const layerCount = await layers();
  await niivue('add_overlay', { url: maskPath, colormap: 'red', opacity: 0.4 });
  assert.equal(await layers(), layerCount + 1, 'a pre-approved local file loads as an overlay');
  // A file outside the approved directory is refused without a dialog.
  const refusedLoad = await client.call('tools/call', { name: 'add_overlay', arguments: { url: fixture } });
  assert.equal(refusedLoad.isError, true, JSON.stringify(refusedLoad.content));
  assert.match(refusedLoad.content[0].text, /not approved in advance/);
  assert.equal(await layers(), layerCount + 1);
  const regrant = await client.tool('sessions_grant', { sessionId, path: maskPath });
  assert.equal(regrant.approval, 'existing', 'a file approved once is not approved again');
  assert.ok(regrant.grantedUrl.startsWith('http://127.0.0.1:'), regrant.grantedUrl);
  const refusedGrant = await client.call('tools/call', { name: 'sessions_grant', arguments: { sessionId, path: fixture } });
  assert.equal(refusedGrant.isError, true, JSON.stringify(refusedGrant.content));
  const record = JSON.parse(await readFile(join(scratch, 'runs', started.id, 'run.json'), 'utf8'));
  assert.deepEqual(record.sources.map(({ path, outcome, approval }) => [path, outcome, approval]),
    [[maskPath, 'approved', 'configured'], [fixture, 'refused', undefined], [fixture, 'refused', undefined]]);
  summary.niivue = { tabs: tabs.text, target, reported, screenshot: nvShot,
    sources: { approvedOverlay: report.artifacts.mask.filename, unapproved: refusedLoad.content[0].text, record: record.sources } };

  // Approved remote images load, granted ahead of time or by the loading tool, though the app's service worker makes
  // the requests. A URL with credentials is refused before anyone is asked.
  const remoteImage = `${remote.origin}/approved/T1.nii.gz`;
  const remoteGrant = await client.tool('sessions_grant', { sessionId, url: remoteImage });
  assert.deepEqual([remoteGrant.grantedUrl, remoteGrant.approval], [remoteImage, 'configured']);
  await niivue('add_overlay', { url: remoteImage, opacity: 0.2 });
  const remoteCopy = `${remote.origin}/approved/copy/T1.nii.gz`;
  await niivue('add_overlay', { url: remoteCopy, opacity: 0.2 });
  assert.equal(await layers(), layerCount + 3, 'both approved remote images load as overlays');
  for (const path of ['/approved/T1.nii.gz', '/approved/copy/T1.nii.gz']) assert.ok(remote.hits.includes(path), `the remote host served ${path}`);
  const credentialed = remoteImage.replace('http://', 'http://reader:secret@');
  for (const [name, args] of [['sessions_grant', { sessionId, url: credentialed }], ['add_overlay', { url: credentialed }]]) {
    const refused = await client.call('tools/call', { name, arguments: args });
    assert.equal(refused.isError, true, `${name}: ${JSON.stringify(refused.content)}`);
    assert.match(refused.content[0].text, /must not contain credentials/);
  }
  const remoteRecord = await readFile(join(scratch, 'runs', started.id, 'run.json'), 'utf8');
  assert.deepEqual(JSON.parse(remoteRecord).sources.slice(3).map(({ url, outcome, approval }) => [url, outcome, approval]),
    [[remoteImage, 'approved', 'configured'], [remoteCopy, 'approved', 'configured']]);
  assert.doesNotMatch(remoteRecord, /secret/);

  // The desktop answers a viewer's https requests itself, for an approved host and for a compute origin. A cookie
  // either host sets stays in that viewer's session.
  for (const host of [secure, compute]) {
    await niivue('add_overlay', { tab: sessionId, url: `${host.origin}/approved/session/T1.nii.gz`, opacity: 0.2 });
    await niivue('add_overlay', { tab: sessionId, url: `${host.origin}/approved/T1.nii.gz`, opacity: 0.2 });
    assert.equal(host.sentCookie('/approved/T1.nii.gz'), true, `the viewer sends back the cookie ${host.origin} set`);
  }
  assert.equal(await layers(), layerCount + 7, 'approved https images load as overlays');

  // A second viewer cannot load the first viewer's file, by its address or by a path relative to its own page, and its
  // run record shows both refusals.
  const second = await waitForRun(client, (await client.tool('run_brain_extraction', request)).id);
  assert.equal(second.state, 'succeeded', JSON.stringify(second.error));
  const otherId = second.session.id;
  const otherViewer = (await client.tool('viewers_list', { sessionId: otherId })).viewers[0].id;
  const otherLayers = async () => (await client.tool('viewers_volumes', { sessionId: otherId, viewerId: otherViewer })).volumes.length;
  const otherCount = await otherLayers();
  const relativeMask = `../_local/${new URL(regrant.grantedUrl).pathname.split('/').slice(2).join('/')}`;
  for (const url of [regrant.grantedUrl, relativeMask]) {
    const crossed = await client.call('tools/call', { name: 'add_overlay', arguments: { tab: otherId, url } });
    assert.equal(crossed.isError, true, `${url}: ${JSON.stringify(crossed.content)}`);
  }
  assert.equal(await otherLayers(), otherCount, 'the second viewer loaded nothing of the first');
  const otherRecord = JSON.parse(await readFile(join(scratch, 'runs', second.id, 'run.json'), 'utf8'));
  assert.deepEqual(otherRecord.sources.map(({ url, outcome }) => [url, outcome]), [[regrant.grantedUrl, 'refused'], [relativeMask, 'refused']]);
  for (const host of [secure, compute]) {
    await niivue('add_overlay', { tab: otherId, url: `${host.origin}/approved/second/T1.nii.gz`, opacity: 0.2 });
    assert.equal(host.sentCookie('/approved/second/T1.nii.gz'), false, `the second viewer does not send the first viewer's cookie to ${host.origin}`);
  }

  // A request refused in a retained viewer is charged to that viewer, not to a run in progress in another window.
  const concurrent = await client.tool('run_brain_extraction', { ...request, retainViewer: false });
  const running = async () => (await client.tool('runs_get', { runId: concurrent.id })).state === 'running';
  let refusedDuringRun = false;
  while (!refusedDuringRun && await running()) {
    for (const host of [remote, secure]) {
      const redirected = await client.call('tools/call', { name: 'add_overlay',
        arguments: { tab: sessionId, url: `${host.origin}/approved/redirect.nii.gz` } });
      assert.equal(redirected.isError, true, JSON.stringify(redirected.content));
    }
    refusedDuringRun = await running();
  }
  assert.ok(refusedDuringRun, 'a refusal came while the other run was in progress');
  for (const host of [remote, secure]) assert.ok(!host.hits.includes('/outside/T1.nii.gz'), `the redirect out of ${host.origin}/approved/ was blocked`);
  const concurrentRun = await waitForRun(client, concurrent.id);
  assert.equal(concurrentRun.state, 'succeeded', JSON.stringify(concurrentRun.error));

  // The first viewer still loads its own file. Closing it ends the address that file was given.
  await niivue('add_overlay', { tab: sessionId, url: regrant.grantedUrl, opacity: 0.2 });
  assert.equal(await layers(), layerCount + 8);
  await client.tool('sessions_close', { sessionId });
  assert.equal(await fetch(regrant.grantedUrl).then(response => response.ok, () => false), false, 'a closed viewer no longer serves its granted file');

  // The next viewer takes the first one's session once it is cleared, and sends none of its cookies.
  const sendsNoCookie = async (tab, path) => {
    for (let tries = 0; !(await niivue('list_tabs')).text.includes(tab); tries++) {
      assert.ok(tries < 100, `the viewer of session ${tab} never connected`);
      await delay(100);
    }
    for (const host of [secure, compute]) {
      await niivue('add_overlay', { tab, url: `${host.origin}${path}`, opacity: 0.2 });
      assert.equal(host.sentCookie(path), false, `${path} carried no cookie to ${host.origin}`);
    }
  };
  await delay(1000);
  const third = await waitForRun(client, (await client.tool('run_brain_extraction', request)).id);
  assert.equal(third.state, 'succeeded', JSON.stringify(third.error));
  await sendsNoCookie(third.session.id, '/approved/third/T1.nii.gz');
  summary.isolation = { remoteHits: remote.hits, secureHits: secure.hits, computeHits: compute.hits, crossViewerRefusals: otherRecord.sources,
    refusedDuringRun, concurrentRun: concurrentRun.state };
  const eofRun = await client.tool('run_brain_extraction', request);
  summary.exit = await client.end();
  const afterEof = JSON.parse(await readFile(join(scratch, 'runs', eofRun.id, 'run.json'), 'utf8'));
  assert.equal(afterEof.state, 'cancelled');
  assert.equal(afterEof.report, undefined);

  // No viewer cookie reaches the profile, so the next launch sends none.
  for (const entry of await readdir(join(scratch, 'profile'), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assert.ok(!(await readFile(join(entry.parentPath, entry.name))).includes(cookieName), `${entry.name} in the profile holds no viewer cookie`);
  }
  client = await start(bundle, { remote, secure, compute });
  const relaunched = await waitForRun(client, (await client.tool('run_brain_extraction', request)).id);
  assert.equal(relaunched.state, 'succeeded', JSON.stringify(relaunched.error));
  await sendsNoCookie(relaunched.session.id, '/approved/relaunched/T1.nii.gz');
  summary.relaunch = await client.end();
  summary.bet = { voxelCount, maskSha256, artifacts: report.artifacts, provenance: report.provenance };
  summary.cancellation = { requested: cancelled.state, stdinClosed: afterEof.state };
  summary.passed = true;
  console.log(`Automation smoke passed: both contracts discovered; BET mask ${voxelCount} voxels; artifacts, retained viewer, per-viewer source and cookie isolation verified; cancellation and clean EOF exit verified.`);
} catch (error) {
  summary.error = error.stack || error.message;
  console.error(summary.error);
  if (client) console.error(client.diagnostics());
  process.exitCode = 1;
} finally {
  await client?.dispose();
  for (const host of [remote, secure, compute]) host?.close();
  if (evidence) {
    await mkdir(evidence, { recursive: true });
    await writeFile(join(evidence, 'automation-smoke.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
  await rm(scratch, { recursive: true, force: true });
}
