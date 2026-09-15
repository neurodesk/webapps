import { app, BrowserWindow, dialog, net, session } from 'electron';
import { appendFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundlePath, canonicalUrl, loadBundle } from './bundle.js';
import { mimeType, startOfflineServer } from './server.js';

const root = process.env.NEURODESK_BUNDLE || (app.isPackaged ? join(process.resourcesPath, 'offline') : resolve('resources'));
if (process.env.NEURODESK_USER_DATA) app.setPath('userData', process.env.NEURODESK_USER_DATA);
app.commandLine.appendSwitch('disable-background-networking');
app.commandLine.appendSwitch('disable-component-update');
app.commandLine.appendSwitch('disable-domain-reliability');
let server;
let window;
const blockedRequests = [];

app.whenReady().then(async () => {
try {
  const bundle = await loadBundle(root);
  const local = await startOfflineServer(root);
  server = local.server;
  const offlineSession = session.fromPartition('offline');
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
  window.once('ready-to-show', () => window.show());
  const selected = process.env.NEURODESK_APP || bundle.defaultApp;
  const selectedApp = selected ? bundle.apps.find(candidate => candidate.id === selected) : null;
  if (selected && !selectedApp) throw new Error(`App is not included: ${selected}`);
  await window.loadURL(`${local.origin}/${selectedApp ? `${selectedApp.path}/` : ''}`);
  // Exposed only to the main process, used by packaged-artifact verification.
  globalThis.neurodeskOffline = { root, origin: local.origin, apps: bundle.apps, blockedRequests };
} catch (error) {
  console.error(error);
  dialog.showErrorBox('Neurodesk offline installation', error.message);
  app.exit(1);
}
});
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => server?.close());
