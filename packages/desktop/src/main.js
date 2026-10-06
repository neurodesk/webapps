import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, net, session, Menu } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalUrl, loadBundle, verifyBundle } from './bundle.js';
import { readJob, runJob } from './jobs.js';
import { mimeType, parseComputeOrigins, startOfflineServer } from './server.js';
import { createModelResolver } from './models.js';
import { createAutomationService, loadAutomationContracts } from './automation.js';
import { generateJob, operationFor } from './contracts.js';
import { runNativeSynthseg } from './native.js';
import { browserDispatcher, runBrowserOperation } from './browser-automation.js';
import { createSourceGrants } from './source-grants.js';
import { completeBrowserArtifacts } from './artifact-completion.js';

const root = process.env.NEURODESK_BUNDLE || (app.isPackaged ? join(process.resourcesPath, 'offline') : resolve('resources'));
if (process.env.NEURODESK_USER_DATA) app.setPath('userData', process.env.NEURODESK_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
if (process.env.NEURODESK_SOFTWARE_RENDERING === '1' || process.argv.includes('--software-rendering')) {
  for (const [name, value] of [['use-angle', 'swiftshader'], ['enable-unsafe-webgpu', '']]) app.commandLine.appendSwitch(name, value);
  if (process.platform === 'linux') {
    for (const [name, value] of [['use-vulkan', 'swiftshader'], ['enable-features', 'Vulkan'], ['disable-vulkan-surface', '']]) app.commandLine.appendSwitch(name, value);
  }
}
let server;
let window;
let mcpServer;
const mcpMode = process.argv.includes('--mcp');
const blockedRequests = [];
const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

app.whenReady().then(async () => {
try {
  const bundle = await loadBundle(root);
  if (mcpMode && argument('--job')) throw new Error('--mcp and --job cannot be used together');
  const job = argument('--job') ? await readJob(resolve(argument('--job'))) : null;
  const pack = process.env.NEURODESK_MODELS_DIR;
  if (pack && !isAbsolute(pack)) throw new Error('NEURODESK_MODELS_DIR must be an absolute path to an extracted model pack');
  const models = createModelResolver(root, bundle, join(app.getPath('userData'), 'models'), { pack });
  const local = await startOfflineServer(root, { resolveFile: models.file });
  server = local.server;
  const offlineSession = session.fromPartition('offline');
  const sourceGrants = createSourceGrants();
  const blockedByWindow = new Map();
  let unattributedBlockedRequests = 0;
  const downloads = [];
  if (process.env.NEURODESK_DOWNLOADS && !mcpMode) {
    const downloadDirectory = resolve(process.env.NEURODESK_DOWNLOADS);
    await mkdir(downloadDirectory, { recursive: true });
    offlineSession.on('will-download', (_event, item) => {
      const filename = basename(item.getFilename());
      const path = join(downloadDirectory, `${randomUUID()}-${filename}`);
      const record = { filename, path, state: 'pending', bytes: 0 };
      downloads.push(record);
      item.setSavePath(path);
      item.once('done', (_event, state) => { record.state = state; record.bytes = item.getReceivedBytes(); });
    });
  }
  app.userAgentFallback += ' NeurodeskOffline/1';
  await mkdir(app.getPath('userData'), { recursive: true });
  const blocked = async (url, contentsId) => {
    blockedRequests.push(url);
    if (contentsId > 0) blockedByWindow.set(contentsId, (blockedByWindow.get(contentsId) ?? 0) + 1);
    else unattributedBlockedRequests++;
    console.error(`OFFLINE_MISSING ${url}`);
    await appendFile(join(app.getPath('userData'), 'offline-missing.jsonl'), `${JSON.stringify({ url })}\n`);
  };
  offlineSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  // Compute origins permit job traffic; automation input grants permit GET/HEAD only.
  const computeOrigins = parseComputeOrigins(process.env.NEURODESK_COMPUTE_ORIGINS);
  const computeRequest = url => computeOrigins.has(url.origin);
  offlineSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const localRequest = url.origin === local.origin;
    const bundledRequest = Boolean(bundle.assets[canonicalUrl(details.url)]);
    const internalRequest = ['data:', 'blob:', 'devtools:'].includes(url.protocol);
    const inputRequest = ['GET', 'HEAD'].includes(details.method) && sourceGrants.permits(details.webContentsId, details.url);
    if (!localRequest && !bundledRequest && !internalRequest && !inputRequest && !computeRequest(url)) {
      void blocked(details.url, details.webContentsId);
      callback({ cancel: true });
    } else callback({});
  });
  // Full installations serve packaged files. The smaller edition can fetch
  // only pinned model assets, which are verified and cached before use.
  offlineSession.protocol.handle('https', async request => {
    if (computeRequest(new URL(request.url))) return net.fetch(request, { bypassCustomProtocolHandlers: true });
    const asset = bundle.assets[canonicalUrl(request.url)];
    if (!asset) {
      if (['GET', 'HEAD'].includes(request.method) && sourceGrants.permitsAny(request.url)) {
        return net.fetch(request, { bypassCustomProtocolHandlers: true, redirect: 'manual' });
      }
      await blocked(request.url);
      return new Response('Asset not included', { status: 404 });
    }
    const requestedHash = new URL(request.url).searchParams.get('sha256');
    if (requestedHash && requestedHash !== asset.sha256) return new Response('Model checksum does not match this installation', { status: 409 });
    let path;
    try { path = await models.asset(canonicalUrl(request.url)); }
    catch (error) { return new Response(error.message, { status: 503 }); }
    const response = await net.fetch(pathToFileURL(path).href);
    return new Response(response.body, { headers: {
      'Content-Type': asset.contentType || mimeType(new URL(request.url).pathname),
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    } });
  });
  const createWindow = () => {
    const target = new BrowserWindow({
      width: 1440, height: 960, show: false,
      webPreferences: { session: offlineSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    target.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== local.origin) event.preventDefault();
    });
    return target;
  };
  const executeBrowser = async ({ contract, operation, request, outputDirectory, signal, onProgress, acceptBrowserOutcome }) => {
    const target = createWindow();
    const contentsId = target.webContents.id;
    const unattributedAtStart = unattributedBlockedRequests;
    const mounts = [];
    const windowClosed = new AbortController();
    const completionSignal = AbortSignal.any([signal, windowClosed.signal]);
    let retained = false;
    const close = () => {
      sourceGrants.remove(contentsId);
      blockedByWindow.delete(contentsId);
      for (const url of mounts.splice(0)) local.unmountDirectory(url);
      if (!target.isDestroyed()) target.destroy();
    };
    target.once('closed', () => {
      windowClosed.abort();
      sourceGrants.remove(contentsId);
      blockedByWindow.delete(contentsId);
      for (const url of mounts.splice(0)) local.unmountDirectory(url);
    });
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      sourceGrants.add(contentsId, Object.values(request.inputs).flatMap(source => source.url ? [source.url] : []));
      const selected = bundle.apps.find(entry => entry.id === contract.app);
      await target.loadURL(`${local.origin}/${selected.path}/`);
      if (request.retainViewer) target.showInactive();
      const outcome = await completeBrowserArtifacts(target.webContents, {
        outputDirectory,
        signal: completionSignal,
        assertHostHealthy() {
          if (target.isDestroyed()) throw new Error('Viewer window is closed');
          if (blockedByWindow.get(contentsId) || unattributedBlockedRequests > unattributedAtStart) {
            throw new Error('The run requested assets absent from the offline package');
          }
        },
      }, async artifacts => {
        const report = contract.schemaVersion === 2
          ? await runBrowserOperation(target.webContents, { contract, operation, request, artifacts, signal: completionSignal, onProgress,
            async mountDirectory(directory) {
              const url = await local.mountDirectory(directory);
              mounts.push(url);
              return url;
            },
          })
          : await runJob(target.webContents, generateJob(contract, request), { artifacts, signal: completionSignal, onProgress });
        let session;
        if (request.retainViewer) {
          const dispatch = browserDispatcher(target.webContents, { signal: completionSignal });
          if (!(await dispatch.call('viewers.list')).length) throw new Error('The app did not register a viewer to retain');
          session = {
            close,
            closedSignal: windowClosed.signal,
            command(command, args, { signal: commandSignal }) {
              if (target.isDestroyed()) throw new Error('Viewer window is closed');
              return browserDispatcher(target.webContents, { signal: commandSignal }).call(command, args);
            },
          };
        }
        const candidate = { report, ...(session && { session }) };
        await acceptBrowserOutcome(candidate);
        return candidate;
      });
      retained = Boolean(outcome.session);
      return retained ? outcome : outcome.report;
    } finally {
      signal.removeEventListener('abort', close);
      if (!retained) close();
    }
  };
  if (mcpMode) {
    const service = createAutomationService({
      contracts: await loadAutomationContracts(root, bundle),
      outputRoot: argument('--output') || join(app.getPath('userData'), 'runs'),
      nativeBinary: process.env.NEURODESK_SYNTHSEG_BIN,
      async execute(options) {
        if (options.request.engine === 'native') return runNativeSynthseg({ ...options, contract: options.operation, binary: options.nativeBinary });
        return executeBrowser(options);
      },
    });
    const { serveMcp } = await import('./mcp.js');
    mcpServer = serveMcp(service, { version: bundle.version });
    process.stdin.once('end', () => { void mcpServer.close().finally(() => app.quit()); });
    return;
  }
  window = createWindow();
  if (!job) window.once('ready-to-show', () => window.show());
  if (process.argv.includes('--verify')) {
    console.log(JSON.stringify(await verifyBundle(root)));
    app.quit();
    return;
  }
  const selected = job?.app || argument('--app') || process.env.NEURODESK_APP || bundle.defaultApp;
  const selectedApp = selected ? bundle.apps.find(candidate => candidate.id === selected) : null;
  if (selected && !selectedApp) throw new Error(`App is not included: ${selected}`);
  if (job?.schemaVersion === 2) {
    sourceGrants.add(window.webContents.id, Object.values(job.request.inputs).flatMap(source => source.url ? [source.url] : []));
  }
  const openZarr = async directory => {
    const zarro = bundle.apps.find(candidate => candidate.id === 'zarro');
    if (!zarro) throw new Error('ZARRo is not included in this package');
    const url = new URL(`/${zarro.path}/`, local.origin);
    url.searchParams.set('source', 'custom');
    url.searchParams.set('url', await local.mountDirectory(directory));
    await window.loadURL(url.href);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []),
    { label: 'File', submenu: [
      { label: 'All applications', click: () => window.loadURL(`${local.origin}/`) },
      { label: 'Open local OME-Zarr folder…', enabled: bundle.apps.some(app => app.id === 'zarro'), click: async () => {
        const result = await dialog.showOpenDialog(window, { properties: ['openDirectory'] });
        if (!result.canceled) await openZarr(result.filePaths[0]).catch(error => dialog.showErrorBox('Open OME-Zarr', error.message));
      } },
      { type: 'separator' },
      { role: 'quit' },
    ] },
    { role: 'editMenu' },
    { role: 'viewMenu' },
  ]));
  if (argument('--zarr')) await openZarr(argument('--zarr'));
  else await window.loadURL(`${local.origin}/${selectedApp ? `${selectedApp.path}/` : ''}`);
  // Exposed only to the main process, used by packaged-artifact verification.
  globalThis.neurodeskOffline = { root, origin: local.origin, apps: bundle.apps, blockedRequests, downloads, mountDirectory: local.mountDirectory };
  if (job) {
    const windowClosed = new AbortController();
    window.once('closed', () => windowClosed.abort());
    const signal = AbortSignal.any([windowClosed.signal,
      AbortSignal.timeout(job.schemaVersion === 2 ? job.request.timeoutMs : job.timeoutMs ?? 900000)]);
    const { report } = await completeBrowserArtifacts(window.webContents, {
      outputDirectory: argument('--output') || resolve('results'),
      signal,
      assertHostHealthy() {
        if (window.isDestroyed()) throw new Error('Job window is closed');
        if (blockedRequests.length) throw new Error(`The job requested ${blockedRequests.length} assets absent from the offline package`);
      },
    }, async artifacts => ({ report: job.schemaVersion === 2
      ? await runBrowserOperation(window.webContents, { contract: job.automation.contract,
        operation: operationFor(job.automation.contract, job.request.operation), request: job.request,
        artifacts, signal, mountDirectory: local.mountDirectory,
      })
      : await runJob(window.webContents, job, { artifacts, signal }),
    }));
    console.log(JSON.stringify(report));
    app.quit();
  }
} catch (error) {
  console.error(error);
  if (!argument('--job') && !mcpMode) dialog.showErrorBox('Neurodesk offline installation', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => { if (!mcpMode) app.quit(); });
app.on('before-quit', () => { server?.close(); void mcpServer?.close(); });
