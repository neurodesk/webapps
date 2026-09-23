import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

// Run site/app-shell.js against a jsdom page the way a hosted app loads it, so
// tests exercise the real shared application bar instead of a stand-in. The
// shell is an ES module; it is evaluated inline with its adapters resolved and
// its analytics import replaced.
export async function mountAppShell({
  appId,
  information = null,
  bodyHtml = '',
  title = 'Demo',
  description = 'A demo app.',
  version = '1.2.3',
  sourceHref = `https://github.com/neurodesk/webapps/tree/main/apps/${appId}`,
  url = `https://webapps.neurodesk.org/${appId}/`,
}) {
  const informationScript = information
    ? `<script type="application/json" data-neurodesk-app-information>${JSON.stringify(information)}</script>`
    : '';
  const html = `<!doctype html><html data-neurodesk-app="${appId}" data-neurodesk-shell="imaging-workspace" data-neurodesk-theme="dark"><head>
    ${informationScript}
    <script type="module" src="./app-shell.js" data-neurodesk-app-shell data-app-id="${appId}" data-app-shell="imaging-workspace" data-app-title="${title}" data-app-description="${description}" data-app-version="${version}" data-ga4-measurement-id="G-TEST" data-analytics-href="./analytics.js" data-more-apps-href="../" data-source-href="${sourceHref}"></script>
    </head><body>${bodyHtml}</body></html>`;
  const dom = new JSDOM(html, { url, pretendToBeVisual: true });
  const { window } = dom;
  window.HTMLDialogElement.prototype.showModal ??= function showModal() { this.setAttribute('open', ''); };
  window.HTMLDialogElement.prototype.close ??= function close() { this.removeAttribute('open'); };
  window.Element.prototype.checkVisibility ??= function checkVisibility() { return true; };
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  globalThis.HTMLElement = window.HTMLElement;
  const shell = await readFile(join(repoRoot, 'site', 'app-shell.js'), 'utf8');
  const adapters = await readFile(join(repoRoot, 'site', 'shell-adapters', 'index.js'), 'utf8');
  const source = shell.replace("import { resolveShellAdapter } from './shell-adapters/index.js';", '')
    .replace(/import\(analyticsUrl\.href\)/, 'Promise.resolve({ initAnalytics() {} })');
  const adapterSource = adapters.replace(/import [^;]+;/g, '').replace(/export /g, '');
  const adapterModules = await Promise.all(['imaging-workspace', 'static-html', 'react'].map(async (name) =>
    (await readFile(join(repoRoot, 'site', 'shell-adapters', `${name}.js`), 'utf8')).replace(/export /g, '')));
  new Function('document', 'window', 'MutationObserver', 'requestAnimationFrame', 'console',
    `${adapterModules.join('\n')}\n${adapterSource}\n${source}`)(window.document, window, window.MutationObserver, globalThis.requestAnimationFrame, console);
  return window;
}
