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
import { browserDispatcher, runBrowserOperation, watchRendererExit } from './browser-automation.js';
import { createSourceGrants } from './source-grants.js';
import { createSourceGranter, parseApprovedSources } from './source-approval.js';
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
// Viewer session clears still running. Quitting waits for them: a clear still running when Electron quits finishes
// after V8 is gone and crashes the process.
const clearing = new Set();
const mcpMode = process.argv.includes('--mcp');
const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};
const approvalTimeoutMs = 30000;
// Unattended setups, where no one can answer a dialog, set this to deny so unapproved sources fail at once.
const sourceApproval = process.env.NEURODESK_SOURCE_APPROVAL || 'ask';
if (!['ask', 'deny'].includes(sourceApproval)) throw new Error('NEURODESK_SOURCE_APPROVAL must be ask or deny');

/** Asks the person at a viewer window whether an agent may load a source its run was not given. */
async function approveSource(target, { app: title, source, signal }) {
  if (sourceApproval === 'deny') throw new Error(`Loading ${source} was not approved in advance, and this desktop does not ask (NEURODESK_SOURCE_APPROVAL=deny).`);
  const timeout = AbortSignal.timeout(approvalTimeoutMs);
  target.show();
  const { response } = await dialog.showMessageBox(target, {
    type: 'question',
    buttons: ['Deny', 'Allow'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    message: `An agent asks to load a file into ${title}.`,
    detail: `${source}\n\nAllow loads it into this viewer only, until the viewer closes.`,
    signal: AbortSignal.any([signal, timeout]),
  });
  if (response === 1) return;
  if (timeout.aborted) throw new Error(`No one approved loading ${source} within ${approvalTimeoutMs / 1000} seconds.`);
  throw new Error(`Loading ${source} was denied.`);
}

app.whenReady().then(async () => {
try {
  const bundle = await loadBundle(root);
  if (mcpMode && argument('--job')) throw new Error('--mcp and --job cannot be used together');
  const job = argument('--job') ? await readJob(resolve(argument('--job'))) : null;
  const pack = process.env.NEURODESK_MODELS_DIR;
  if (pack && !isAbsolute(pack)) throw new Error('NEURODESK_MODELS_DIR must be an absolute path to an extracted model pack');
  const models = createModelResolver(root, bundle, join(app.getPath('userData'), 'models'), { pack });
  app.userAgentFallback += ' NeurodeskOffline/1';
  await mkdir(app.getPath('userData'), { recursive: true });
  const blocked = async (viewer, url) => {
    viewer.blocked.push(url);
    console.error(`OFFLINE_MISSING ${url}`);
    await appendFile(join(app.getPath('userData'), 'offline-missing.jsonl'), `${JSON.stringify({ url })}\n`);
  };
  // Compute origins permit job traffic; a viewer's source grants permit GET/HEAD only.
  const computeOrigins = parseComputeOrigins(process.env.NEURODESK_COMPUTE_ORIGINS);
  const computeRequest = url => computeOrigins.has(url.origin);
  const approvedSources = parseApprovedSources(process.env.NEURODESK_APPROVED_SOURCES);
  /**
   * Binds `ses` to one viewer, `{ origin, grants, blocked }`. Service worker requests name no window, so the session is
   * what tells viewers apart. Everything it sees is checked against this viewer's address and grants, and charged to
   * this viewer when refused.
   */
  const isolate = (ses, viewer) => {
    ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    ses.webRequest.onBeforeRequest((details, callback) => {
      const url = new URL(details.url);
      const localRequest = url.origin === viewer.origin;
      const bundledRequest = Boolean(bundle.assets[canonicalUrl(details.url)]);
      const internalRequest = ['data:', 'blob:', 'devtools:'].includes(url.protocol);
      const inputRequest = ['GET', 'HEAD'].includes(details.method) && viewer.grants.permits(details.url);
      if (!localRequest && !bundledRequest && !internalRequest && !inputRequest && !computeRequest(url)) {
        void blocked(viewer, details.url);
        callback({ cancel: true });
      } else callback({});
    });
    // Full installations serve packaged files. The smaller edition can fetch
    // only pinned model assets, which are verified and cached before use.
    // The request filter never sees https requests this handler answers. It fetches in this viewer's session, not
    // net.fetch's default one, so a cookie a host sets stays with this viewer and is cleared with it.
    if (ses.protocol.isProtocolHandled('https')) ses.protocol.unhandle('https');
    ses.protocol.handle('https', async request => {
      if (computeRequest(new URL(request.url))) return ses.fetch(request, { bypassCustomProtocolHandlers: true });
      const asset = bundle.assets[canonicalUrl(request.url)];
      if (!asset) {
        if (['GET', 'HEAD'].includes(request.method) && viewer.grants.permits(request.url)) {
          return ses.fetch(request, { bypassCustomProtocolHandlers: true, redirect: 'manual' });
        }
        await blocked(viewer, request.url);
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
  };
  const createWindow = (ses, origin) => {
    const target = new BrowserWindow({
      width: 1440, height: 960, show: false,
      webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    target.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== origin) event.preventDefault();
    });
    return target;
  };
  // Cleared viewer sessions, reused because Electron never frees a partition once it exists.
  const partitions = [];
  let partitionCount = 0;
  const executeBrowser = async ({ contract, operation, request, outputDirectory, signal, onProgress, acceptBrowserOutcome }) => {
    const site = await startOfflineServer(root, { resolveFile: models.file });
    const viewerSession = partitions.pop() ?? session.fromPartition(`viewer-${++partitionCount}`);
    const viewer = { origin: site.origin, grants: createSourceGrants(), blocked: [] };
    isolate(viewerSession, viewer);
    const target = createWindow(viewerSession, site.origin);
    const windowClosed = new AbortController();
    const renderer = watchRendererExit(target.webContents);
    const completionSignal = AbortSignal.any([signal, windowClosed.signal, renderer.signal]);
    renderer.signal.addEventListener('abort', () => windowClosed.abort(renderer.signal.reason), { once: true });
    let retained = false;
    let released = false;
    const close = () => {
      if (released) return;
      released = true;
      renderer.dispose();
      site.close();
      if (!target.isDestroyed()) target.destroy();
      // The session goes back to the pool only once nothing of this viewer is left in it. Quitting waits for both
      // clears to settle, even when one fails.
      const cleared = Promise.allSettled([viewerSession.clearStorageData(), viewerSession.clearCache()]).then(results => {
        const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
        if (errors.length) console.error(`A viewer session could not be cleared and is not reused: ${errors.join('; ')}`);
        else partitions.push(viewerSession);
      });
      clearing.add(cleared);
      void cleared.finally(() => clearing.delete(cleared));
    };
    target.once('closed', () => {
      windowClosed.abort();
      close();
    });
    signal.addEventListener('abort', close, { once: true });
    try {
      signal.throwIfAborted();
      viewer.grants.add(Object.values(request.inputs).flatMap(source => source.url ? [source.url] : []));
      const selected = bundle.apps.find(entry => entry.id === contract.app);
      const loading = browserDispatcher(target.webContents, { signal: completionSignal, timeoutMs: request.timeoutMs });
      await loading.bounded(target.loadURL(`${site.origin}/${selected.path}/`));
      if (request.retainViewer) target.showInactive();
      const outcome = await completeBrowserArtifacts(target.webContents, {
        outputDirectory,
        signal: completionSignal,
        assertHostHealthy() {
          if (target.isDestroyed()) throw new Error('Viewer window is closed');
          if (viewer.blocked.length) throw new Error('The run requested assets absent from the offline package');
        },
      }, async artifacts => {
        const report = contract.schemaVersion === 2
          ? await runBrowserOperation(target.webContents, { contract, operation, request, artifacts, signal: completionSignal, onProgress,
            mountDirectory: site.mountDirectory,
          })
          : await runJob(target.webContents, generateJob(contract, request), { artifacts, signal: completionSignal, onProgress });
        let session;
        if (request.retainViewer) {
          const dispatch = browserDispatcher(target.webContents, { signal: completionSignal });
          if (!(await dispatch.call('viewers.list')).length) throw new Error('The app did not register a viewer to retain');
          const grant = createSourceGranter({ site, grants: viewer.grants, approved: approvedSources,
            ask: (source, approvalSignal) => approveSource(target, { app: contract.title ?? contract.app, source, signal: approvalSignal }),
          });
          session = {
            close,
            closedSignal: windowClosed.signal,
            async command(command, args, { signal: commandSignal }) {
              if (target.isDestroyed()) throw new Error('Viewer window is closed');
              const page = browserDispatcher(target.webContents, { signal: commandSignal });
              if (command !== 'viewers.screenshot') return page.call(command, args);
              // Capture the composited window: WebGL and WebGPU canvases need not keep their drawing buffer.
              const rect = await page.call('viewers.canvas', args);
              const image = await page.bounded(target.webContents.capturePage(rect));
              const { width, height } = image.getSize();
              if (!width || !height) throw new Error('The viewer screenshot is empty');
              return { mimeType: 'image/png', width, height, data: image.toPNG().toString('base64') };
            },
            async grantSource(source, { signal: sessionSignal }) {
              if (target.isDestroyed()) throw new Error('Viewer window is closed');
              const granted = await grant(source, { base: target.webContents.getURL(), signal: sessionSignal });
              if (target.isDestroyed()) throw new Error('Viewer window is closed');
              return granted;
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
  const local = await startOfflineServer(root, { resolveFile: models.file });
  server = local.server;
  const offlineSession = session.fromPartition('offline');
  // The main window is alone in its session, so it is isolated like any other viewer.
  const mainViewer = { origin: local.origin, grants: createSourceGrants(), blocked: [] };
  isolate(offlineSession, mainViewer);
  const downloads = [];
  if (process.env.NEURODESK_DOWNLOADS) {
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
  window = createWindow(offlineSession, local.origin);
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
    mainViewer.grants.add(Object.values(job.request.inputs).flatMap(source => source.url ? [source.url] : []));
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
  globalThis.neurodeskOffline = { root, origin: local.origin, apps: bundle.apps, blockedRequests: mainViewer.blocked, downloads, mountDirectory: local.mountDirectory };
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
        if (mainViewer.blocked.length) throw new Error(`The job requested ${mainViewer.blocked.length} assets absent from the offline package`);
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
app.on('will-quit', event => {
  if (!clearing.size) return;
  event.preventDefault();
  void Promise.all(clearing).then(() => app.quit());
});
