import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, dialog, net, session, Menu } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundlePath, canonicalUrl, loadBundle, verifyBundle } from './bundle.js';
import { readJob, runJob } from './jobs.js';
import { mimeType, startOfflineServer } from './server.js';

const root = process.env.NEURODESK_BUNDLE || (app.isPackaged ? join(process.resourcesPath, 'offline') : resolve('resources'));
if (process.env.NEURODESK_USER_DATA) app.setPath('userData', process.env.NEURODESK_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
if (process.env.NEURODESK_SOFTWARE_RENDERING === '1' || process.argv.includes('--software-rendering')) {
  for (const [name, value] of [['use-gl', 'angle'], ['use-angle', 'swiftshader'], ['enable-unsafe-swiftshader', ''], ['enable-unsafe-webgpu', '']]) app.commandLine.appendSwitch(name, value);
}
let server;
let window;
const blockedRequests = [];
const argument = name => {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
};

app.whenReady().then(async () => {
try {
  const bundle = await loadBundle(root);
  const job = argument('--job') ? await readJob(resolve(argument('--job'))) : null;
  const local = await startOfflineServer(root);
  server = local.server;
  const offlineSession = session.fromPartition('offline');
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
  app.userAgentFallback += ' NeurodeskOffline/1';
  await mkdir(app.getPath('userData'), { recursive: true });
  const blocked = async url => {
    blockedRequests.push(url);
    console.error(`OFFLINE_MISSING ${url}`);
    await appendFile(join(app.getPath('userData'), 'offline-missing.jsonl'), `${JSON.stringify({ url })}\n`);
  };
  offlineSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  offlineSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const localRequest = url.origin === local.origin;
    const bundledRequest = Boolean(bundle.assets[canonicalUrl(details.url)]);
    const internalRequest = ['data:', 'blob:', 'devtools:'].includes(url.protocol);
    if (!localRequest && !bundledRequest && !internalRequest) {
      void blocked(details.url);
      callback({ cancel: true });
    } else callback({});
  });
  // HTTPS is served exclusively from verified packaged files, including in
  // workers. There is no network fallback, cache warming or model downloader.
  offlineSession.protocol.handle('https', async request => {
    const asset = bundle.assets[canonicalUrl(request.url)];
    if (!asset) {
      await blocked(request.url);
      return new Response('Asset not included', { status: 404 });
    }
    const requestedHash = new URL(request.url).searchParams.get('sha256');
    if (requestedHash && requestedHash !== asset.sha256) return new Response('Model checksum does not match this installation', { status: 409 });
    const response = await net.fetch(pathToFileURL(bundlePath(root, asset.path)).href);
    return new Response(response.body, { headers: {
      'Content-Type': asset.contentType || mimeType(new URL(request.url).pathname),
      'Access-Control-Allow-Origin': '*',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    } });
  });
  window = new BrowserWindow({
    width: 1440, height: 960, show: false,
    webPreferences: { session: offlineSession, sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => {
    if (new URL(url).origin !== local.origin) event.preventDefault();
  });
  if (!job) window.once('ready-to-show', () => window.show());
  if (process.argv.includes('--verify')) {
    console.log(JSON.stringify(await verifyBundle(root)));
    app.quit();
    return;
  }
  const selected = job?.app || argument('--app') || process.env.NEURODESK_APP || bundle.defaultApp;
  const selectedApp = selected ? bundle.apps.find(candidate => candidate.id === selected) : null;
  if (selected && !selectedApp) throw new Error(`App is not included: ${selected}`);
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
    const result = await runJob(window.webContents, job, argument('--output') || resolve('results'));
    if (blockedRequests.length) throw new Error(`The job requested ${blockedRequests.length} assets absent from the offline package`);
    console.log(JSON.stringify(result));
    app.quit();
  }
} catch (error) {
  console.error(error);
  if (!argument('--job')) dialog.showErrorBox('Neurodesk offline installation', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server?.close());
