#!/usr/bin/env node
// What the shell's Undo of a page drop leaves in each app, recorded so two builds can be compared.
// For every app of a built site with a classified file input, in Chromium:
//   (a) pick a scan, drop another on the page, Undo;
//   (b) with a file in the app's second input and its selects and text fields changed first: pick a
//       scan, remove it with the app's own control, drop another, Undo.
// After each step it records what the person and a run would meet: the file names the workspace shows
// and its classified inputs hold, what each registered viewer shows (names and dimensions), the files
// and volumes the app's own state object (window.app) holds, and every other control's value.
// The scans differ in size (pick 10³, drop 12³, second input 14³), so a viewer volume shows which it is.
//
//   pnpm build && node test/page-drop-undo.smoke.mjs --dist dist --out head.json
//   node test/page-drop-undo.smoke.mjs --dist ../base/dist --out base.json
//   node test/page-drop-undo.smoke.mjs --diff base.json head.json
//   SMOKE_APPS=nesvor,qsmbly node test/page-drop-undo.smoke.mjs --out narrow.json
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { smokeApps } from '../scripts/lib/smoke-apps.mjs';
import { syntheticNifti } from '../test-utils/nifti-fixture.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: { dist: { type: 'string', default: join(repoRoot, 'dist') }, out: { type: 'string' }, diff: { type: 'boolean', default: false } },
});

// The differences between two recordings, app by app and step by step.
export function differences(base, head) {
  const lines = [];
  for (const app of [...new Set([...Object.keys(base), ...Object.keys(head)])].sort()) {
    const [was, now] = [base[app], head[app]];
    if (!was || !now) {
      lines.push(`${app}: only in ${was ? 'base' : 'head'}`);
      continue;
    }
    for (const sequence of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
      const [a, b] = [was[sequence] ?? [], now[sequence] ?? []];
      for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
        const [left, right] = [a[index], b[index]];
        for (const field of [...new Set([...Object.keys(left ?? {}), ...Object.keys(right ?? {})])]) {
          if (JSON.stringify(left?.[field]) !== JSON.stringify(right?.[field])) {
            lines.push(`${app} ${sequence} ${left?.step ?? right?.step} ${field}: base ${JSON.stringify(left?.[field])} | head ${JSON.stringify(right?.[field])}`);
          }
        }
      }
    }
  }
  return lines;
}

if (options.diff) {
  const [basePath, headPath] = positionals;
  const lines = differences(JSON.parse(await readFile(basePath, 'utf8')), JSON.parse(await readFile(headPath, 'utf8')));
  console.log(lines.length ? lines.join('\n') : 'No differences');
  process.exit(lines.length ? 1 : 0);
}

const REMOVERS = /remove|clear|delete|reset|discard|^\s*[×✕]\s*$/i;
const NARRATION = 'footer#status, nd-console, .nd-console-container, .console-container, #neurodeskAgentPrompt, .nd-app-bar, .nd-app-utility-bar, dialog.nd-app-dialog, script, style';
const OURS = /\b(?:pick|drop|other)-scan\.nii\.gz\b/g;
const AUXILIARY = ['gradients', 'model', 'protocol', 'metadata', 'mask'];

const scratch = await mkdtemp(join(tmpdir(), 'page-drop-undo-'));
const scans = {};
for (const [name, size] of [['pick', 10], ['drop', 12], ['other', 14]]) {
  scans[name] = { path: join(scratch, `${name}-scan.nii.gz`), size };
  await writeFile(scans[name].path, syntheticNifti({ dims: [size, size, size], value: index => index % 7 }));
}

// The state of the page the person and a run would meet.
const observe = page => page.evaluate(async ([narration, ours, removers]) => {
  const pattern = new RegExp(ours, 'g');
  const shown = new Set();
  const inputs = {};
  const controls = {};
  const walk = root => {
    for (const node of root.querySelectorAll('*')) {
      if (node.closest(narration)) continue;
      for (const child of node.childNodes) if (child.nodeType === 3) for (const name of child.textContent.match(pattern) ?? []) shown.add(name);
      if (node.matches('input[type="file"][data-neurodesk-input]') && node.id !== 'neurodesk-input-transfer') inputs[node.id || node.name || 'input'] = [...(node.files ?? [])].map(file => file.name);
      else if (node.matches('select, input:not([type="file"]):not([type="hidden"]), textarea') && (node.id || node.name)) {
        controls[node.id || node.name] = node.type === 'checkbox' || node.type === 'radio' ? node.checked : node.value;
      }
      if (node.shadowRoot) walk(node.shadowRoot);
    }
  };
  walk(document);
  const volume = item => ({ name: item.name ?? null, dims: item.dims ? [...item.dims].slice(1, 4) : item.hdr?.dims ? [...item.hdr.dims].slice(1, 4) : null });
  const viewers = {};
  try {
    for (const viewer of await window.neurodeskAutomation.dispatch('viewers.list')) {
      try {
        viewers[viewer.id] = (await window.neurodeskAutomation.dispatch('viewers.volumes', { viewerId: viewer.id })).map(volume);
      } catch (error) {
        viewers[viewer.id] = `unreadable: ${error.message}`;
      }
    }
  } catch {
    // No automation viewer registry: the app's own state below still shows its viewer.
  }
  // The app's own state object, one level deep: files, lists of files or records holding one, and NiiVue volumes.
  const state = {};
  const named = value => (value instanceof File ? value.name : value?.file instanceof File ? value.file.name : null);
  const describe = (value, depth) => {
    if (value == null || typeof value !== 'object') return undefined;
    if (named(value)) return named(value);
    if (Array.isArray(value)) {
      const names = value.map(named).filter(Boolean);
      return names.length || !value.length ? (names.length ? names : undefined) : undefined;
    }
    if (Array.isArray(value.volumes) && value.volumes.every(item => item && typeof item === 'object')) return { volumes: value.volumes.map(volume) };
    if (depth > 0) {
      const inner = {};
      for (const [key, item] of Object.entries(value)) {
        const described = describe(item, depth - 1);
        if (described !== undefined) inner[key] = described;
      }
      return Object.keys(inner).length ? inner : undefined;
    }
    return undefined;
  };
  if (window.app && typeof window.app === 'object') {
    for (const [key, value] of Object.entries(window.app)) {
      const described = describe(value, 1);
      if (described !== undefined) state[key] = described;
    }
  }
  return { shown: [...shown].sort(), inputs, viewers, state, controls };
}, [NARRATION, OURS.source, String(REMOVERS)]);

// The page once it stops changing: 1.5 s unchanged, at most `longest` ms.
async function settled(page, longest = 20000) {
  let last = JSON.stringify(await observe(page));
  for (let since = Date.now(), deadline = Date.now() + longest; Date.now() - since < 1500 && Date.now() < deadline;) {
    await page.waitForTimeout(250);
    const now = JSON.stringify(await observe(page));
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
  return JSON.parse(last);
}

async function open(context, app) {
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(`${origin}/${app.path}/`, { waitUntil: 'load', timeout: 90000 });
  if (app.id === 'dicompare') await page.getByRole('link', { name: 'Open Workspace' }).click().catch(() => {});
  await page.waitForFunction(auxiliary => {
    const usable = input => input.id !== 'neurodesk-input-transfer' && !input.disabled && !input.hasAttribute('webkitdirectory') && !input.closest('[inert], dialog:not([open])');
    const inputs = [...document.querySelectorAll('input[type="file"][data-neurodesk-input]')].filter(usable);
    const primary = inputs.find(input => !auxiliary.includes(input.dataset.neurodeskInput)) ?? inputs[0];
    if (!primary) return false;
    for (const input of document.querySelectorAll('[data-undo-role]')) delete input.dataset.undoRole;
    primary.dataset.undoRole = 'primary';
    const second = inputs.find(input => input !== primary && input.dataset.neurodeskInput !== 'mask');
    if (second) second.dataset.undoRole = 'second';
    return true;
  }, AUXILIARY, { timeout: 60000 });
  await settled(page);
  return page;
}

async function drop(context, page) {
  const target = await page.locator('footer#status, #status').first().boundingBox();
  const [x, y] = [Math.round(target.x + target.width / 2), Math.round(target.y + target.height / 2)];
  const cdp = await context.newCDPSession(page);
  const data = { items: [], files: [scans.drop.path], dragOperationsMask: 1 };
  for (const type of ['dragEnter', 'dragOver', 'drop']) await cdp.send('Input.dispatchDragEvent', { type, x, y, data });
  await cdp.detach();
  await page.locator('button.nd-status-undo').waitFor({ timeout: 20000 });
}

async function undo(page) {
  await page.locator('button.nd-status-undo').click();
}

// The app's own control that takes the picked scan out of the workspace, tried in page order.
async function remove(page) {
  const names = await page.evaluate(([narration, removers]) => {
    const pattern = new RegExp(removers.slice(1, removers.lastIndexOf('/')), removers.slice(removers.lastIndexOf('/') + 1));
    const found = [];
    for (const button of document.querySelectorAll('button')) {
      if (button.closest(narration) || button.closest('footer#status') || button.disabled || !button.checkVisibility?.()) continue;
      const name = (button.getAttribute('aria-label') || button.title || button.textContent).trim();
      if (pattern.test(name)) {
        button.dataset.undoRemover = String(found.length);
        found.push(name);
      }
    }
    return found;
  }, [NARRATION, String(REMOVERS)]);
  for (const [index, name] of names.entries()) {
    await page.locator(`[data-undo-remover="${index}"]`).click({ timeout: 3000 }).catch(() => {});
    const after = await settled(page);
    if (!after.shown.includes('pick-scan.nii.gz')) return { name, after };
  }
  return null;
}

// Every visible select to another option and every visible text or number field to a recognisable value.
async function changeSettings(page) {
  await page.evaluate(narration => {
    for (const element of document.querySelectorAll('select, input[type="text"], input[type="number"]')) {
      // The example selector loads data rather than setting anything.
      if (element.closest(narration) || element.closest('nd-example-selector') || element.disabled || !element.checkVisibility?.()) continue;
      if (element.localName === 'select') {
        const other = [...element.options].find(option => !option.disabled && option.value !== element.value);
        if (!other) continue;
        element.value = other.value;
      } else if (element.type === 'number') {
        const min = Number(element.min || 0);
        element.value = String(Number.isFinite(min) ? min + 1 : 1);
      } else {
        element.value = 'undo-check';
      }
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    }
  }, NARRATION);
}

const registry = await loadAppsRegistry();
const { apps } = smokeApps(registry.apps);
const site = await serveSite(resolve(options.dist));
const origin = site.origin;
const browser = await chromium.launch();
const recording = {};
try {
  for (const app of apps) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
    await context.route(/googletagmanager\.com|google-analytics\.com|cloudflareinsights\.com/, route => route.abort());
    const record = recording[app.id] = { a: [], b: [] };
    const step = (sequence, name, state) => record[sequence].push({ step: name, ...state });
    try {
      let page = await open(context, app).catch(() => null);
      if (!page) {
        record.skipped = 'no classified file input';
        console.log(`SKIP ${app.id}: ${record.skipped}`);
        continue;
      }
      try {
        await page.locator('[data-undo-role="primary"]').setInputFiles(scans.pick.path);
        step('a', 'pick', await settled(page));
        await drop(context, page);
        // Undo is offered for 8 s after the drop.
        step('a', 'drop', await settled(page, 5000));
        await undo(page);
        step('a', 'undo', await settled(page));
      } catch (error) {
        record.a.push({ step: 'error', message: error.message.split('\n')[0] });
      }
      await page.close();

      page = await open(context, app);
      try {
        if (await page.locator('[data-undo-role="second"]').count()) await page.locator('[data-undo-role="second"]').setInputFiles(scans.other.path);
        await changeSettings(page);
        step('b', 'settings', await settled(page));
        await page.locator('[data-undo-role="primary"]').setInputFiles(scans.pick.path);
        step('b', 'pick', await settled(page));
        // Without a control of its own that removes the scan, the drop follows the pick.
        const removed = await remove(page);
        if (removed) step('b', `remove (${removed.name})`, removed.after);
        else step('b', 'no remove control', await settled(page));
        await drop(context, page);
        step('b', 'drop', await settled(page, 5000));
        await undo(page);
        step('b', 'undo', await settled(page));
      } catch (error) {
        record.b.push({ step: 'error', message: error.message.split('\n')[0] });
      }
      console.log(`DONE ${app.id}: a ${record.a.map(item => item.step).join(' > ')}; b ${record.b.map(item => item.step).join(' > ')}`);
    } finally {
      await context.close();
    }
  }
} finally {
  await browser.close();
  await site.close();
  await rm(scratch, { recursive: true, force: true });
}
assert.ok(Object.keys(recording).length, 'no app was checked');
if (options.out) await writeFile(options.out, `${JSON.stringify(recording, null, 2)}\n`);
else console.log(JSON.stringify(recording, null, 2));
