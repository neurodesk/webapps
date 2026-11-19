#!/usr/bin/env node
// Whatever an app does with a control, the person using it ends the agent's examination. For every app
// of the built site (dist/), in Chromium with Chrome's own WebMCP: the agent holds a file, the person
// performs one trusted action (a pick in each file input, a click on each remove or clear button, the
// first select, checkbox, text field and viewer canvas), and the tools must hold nothing afterwards.
// An action that could not be performed fails its app unless test/webmcp-interaction-skips.json names
// it with the reason, and so does an app where no action was performed: a check that acted on nothing
// proves nothing.
//
//   pnpm build && node test/webmcp-interaction.smoke.mjs
//   SMOKE_APPS=qsmbly,dcm2niix WEBMCP_REPORT=interaction.json node test/webmcp-interaction.smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { requireChecked, smokeApps } from '../scripts/lib/smoke-apps.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';
import { syntheticNifti } from '../test-utils/nifti-fixture.mjs';

const GPU_ARGS = process.platform === 'linux' ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--disable-vulkan-surface'] : [];
const FEATURES = `--enable-features=${[...(process.platform === 'linux' ? ['Vulkan'] : []), 'WebMCPTesting'].join(',')}`;
const REMOVERS = /remove|clear|delete|reset|discard|^\s*[×✕]\s*$/i;
const APP_SECONDS = Number(process.env.WEBMCP_APP_SECONDS ?? 300);
// dicompare, a copy of an upstream app, opens on its own home route; its workspace is one link away.
const WORKSPACE_LINKS = { dicompare: 'Open Workspace' };
const WORKSPACE = ':not(#neurodeskAgentPrompt *):not(.nd-app-bar *):not(.nd-app-utility-bar *):not(dialog.nd-app-dialog *)';

// Per app, the actions expected not to be performed ("<kind> <name>": reason), or "*" for an app where
// no action can be.
const SKIPS = JSON.parse(await readFile(new URL('./webmcp-interaction-skips.json', import.meta.url), 'utf8'));
const registry = await loadAppsRegistry();
const selection = smokeApps(registry.apps);
const { apps } = selection;
for (const id of Object.keys(SKIPS)) assert.ok(registry.apps.some(app => app.id === id), `webmcp-interaction-skips.json names ${id}, which the registry does not have`);
const scratch = await mkdtemp(join(tmpdir(), 'webmcp-interaction-'));
const scanPath = join(scratch, 'person-scan.nii.gz');
await writeFile(scanPath, syntheticNifti({ dims: [8, 8, 8] }));
const folder = join(scratch, 'person-folder');
await mkdir(folder);
await writeFile(join(folder, 'slice.nii.gz'), syntheticNifti({ dims: [8, 8, 8] }));

const { origin, close } = await serveSite(join(repoRoot, 'dist'));
const browser = await chromium.launch({ args: [...GPU_ARGS, FEATURES] });
const report = [];
const PERFORMED = new Set(['released', 'FILES STILL HELD']);

async function tools(page) {
  const deadline = Date.now() + 90000;
  while (!(await page.evaluate(async () => Boolean(document.modelContext) && (await document.modelContext.getTools()).some(tool => tool.name === 'app_describe')))) {
    if (Date.now() > deadline) throw new Error('the tools did not register');
    await page.waitForTimeout(250);
  }
}

const call = (page, name, input = {}) => page.evaluate(async ([name, input]) => {
  const tool = (await document.modelContext.getTools()).find(candidate => candidate.name === name);
  return JSON.parse(await document.modelContext.executeTool(tool, input));
}, [name, input]);

// The agent asks for a file and the test answers inside the agent's own dialog, which is not the workspace.
async function hold(page, { role, count }) {
  await page.evaluate(([role]) => {
    globalThis.interactionHold = document.modelContext.getTools()
      .then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === 'inputs_request_files'), { role }));
  }, [role]);
  const field = page.locator('dialog#neurodeskAgentPrompt input[type="file"]').first();
  await field.waitFor({ state: 'attached', timeout: 10000 });
  await field.setInputFiles(Array.from({ length: count }, (_, index) => ({ name: `agent-held-${index + 1}.nii.gz`, mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [8, 8, 8] }) })));
  const held = await page.evaluate(() => Promise.race([globalThis.interactionHold, new Promise(resolve => { setTimeout(() => resolve('{}'), 10000); })]));
  return Boolean(JSON.parse(held).files);
}

// Actions the person can take; each element is marked so the action finds it again.
async function actions(page) {
  return page.evaluate(([workspace, removers]) => {
    const visible = element => element.checkVisibility?.() !== false && element.getBoundingClientRect().width > 0;
    const list = [];
    const mark = (element, action) => {
      element.dataset.interactionTarget = String(list.length);
      list.push({ ...action, selector: `[data-interaction-target="${list.length}"]` });
    };
    for (const input of document.querySelectorAll(`input[type="file"][data-neurodesk-input]${workspace}`)) {
      if (input.id !== 'neurodesk-input-transfer') mark(input, { kind: input.hasAttribute('webkitdirectory') ? 'folder input' : 'file input', name: input.id || input.getAttribute('aria-label') || 'unnamed', directory: input.hasAttribute('webkitdirectory') });
    }
    const pattern = new RegExp(removers.slice(1, removers.lastIndexOf('/')), removers.slice(removers.lastIndexOf('/') + 1));
    for (const button of document.querySelectorAll(`button${workspace}`)) {
      const name = (button.getAttribute('aria-label') || button.title || button.textContent).trim();
      if (visible(button) && !button.disabled && pattern.test(name)) mark(button, { kind: 'remove or clear button', name });
    }
    for (const [kind, selector] of [['select', `select${workspace}`], ['checkbox', `input[type="checkbox"]${workspace}`], ['text field', `input[type="text"]${workspace}, input[type="number"]${workspace}, textarea${workspace}`], ['viewer canvas', `canvas${workspace}`]]) {
      const element = [...document.querySelectorAll(selector)].find(candidate => visible(candidate) && !candidate.disabled);
      if (element) mark(element, { kind, name: element.id || kind });
    }
    return list;
  }, [WORKSPACE, String(REMOVERS)]);
}

// Whether the control is the topmost element at its centre, where a person's click lands.
const onTop = selector => {
  const element = document.querySelector(selector);
  if (!element) return false;
  element.scrollIntoView({ block: 'center' });
  const box = element.getBoundingClientRect();
  const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
  return box.width > 0 && (top === element || element.contains(top));
};

async function perform(context, page, action) {
  const locator = page.locator(action.selector);
  // A busy app may cover its controls for a while after the previous action; wait for it, not a fixed time.
  if (!action.kind.endsWith('input')) await page.waitForFunction(onTop, action.selector, { timeout: 20000, polling: 250 }).catch(() => {});
  if (action.kind.endsWith('input')) {
    const cdp = await context.newCDPSession(page);
    const { result } = await cdp.send('Runtime.evaluate', { expression: `document.querySelector('${action.selector}')` });
    await cdp.send('DOM.setFileInputFiles', { objectId: result.objectId, files: [action.directory ? folder : scanPath] });
    await cdp.detach();
  } else if (action.kind === 'select') {
    await locator.click({ timeout: 5000 });
    await page.keyboard.press('Escape');
  } else if (action.kind === 'text field') {
    await locator.click({ timeout: 5000 });
    await page.keyboard.type('1');
  } else {
    await locator.click({ timeout: 5000, force: true });
  }
}

// The app as the person finds it with files loaded: loaded files bring up the remove and clear buttons
// an app shows only for a loaded list.
async function prepare(context, app) {
  const page = await context.newPage();
  await page.goto(`${origin}/${app.path}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await tools(page);
  if (WORKSPACE_LINKS[app.id]) await page.getByRole('link', { name: WORKSPACE_LINKS[app.id] }).click();
  const fileInputs = page.locator(`input[type="file"][data-neurodesk-input]${WORKSPACE}:not(#neurodesk-input-transfer):not([webkitdirectory])`);
  for (let index = 0; index < await fileInputs.count(); index += 1) {
    await fileInputs.nth(index).setInputFiles({ name: `loaded-${index + 1}.nii.gz`, mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [8, 8, 8] }) }).catch(() => {});
  }
  await page.waitForTimeout(1500);
  return page;
}

// One action on the page as it stands: the agent holds a file, the person acts, the tools answer.
async function attempt(context, page, app, target, action, outcome) {
  if (!await hold(page, target)) return 'the agent could not hold a file';
  try {
    await perform(context, page, action);
  } catch (error) {
    const where = await page.evaluate(selector => {
      const element = document.querySelector(selector);
      if (!element) return 'absent';
      const box = element.getBoundingClientRect();
      const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
      if (top === element || element.contains(top)) return `on top, ${Math.round(box.width)}x${Math.round(box.height)} at ${Math.round(box.x)},${Math.round(box.y)}`;
      return `under ${top ? top.outerHTML.slice(0, 160) : 'nothing (outside the viewport)'}`;
    }, action.selector).catch(() => 'unknown');
    return `not performed: ${error.message.split('\n')[0]} [${where}]`;
  }
  await page.waitForTimeout(300);
  if (!page.url().startsWith(`${origin}/${app.path}/`)) return 'navigated away';
  const after = await call(page, 'app_describe');
  outcome.held = Object.keys(after.inputs);
  return outcome.held.length ? 'FILES STILL HELD' : 'released';
}

try {
  for (const app of apps) {
    const entry = { app: app.id, actions: [] };
    report.push(entry);
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true, serviceWorkers: 'block' });
    await context.route(/googletagmanager\.com|google-analytics\.com|cloudflareinsights\.com/, route => route.abort());
    const progress = { phase: 'opening the page' };
    const timer = { id: null };
    // A page that stops answering (a busy worker after a click) fails its app instead of stalling the catalogue.
    const deadline = new Promise((_, reject) => { timer.id = setTimeout(() => reject(new Error(`no answer within ${APP_SECONDS} s while ${progress.phase}`)), APP_SECONDS * 1000); });
    try {
      await Promise.race([deadline, (async () => {
        let page = await prepare(context, app);
        const describe = await call(page, 'app_describe');
        const [role, field] = Object.values(describe.operations).flatMap(operation => Object.entries(operation.inputs)).find(([, input]) => input.source === 'files') ?? [];
        const target = role && { role, count: Math.max(1, field.minimum) };
        if (!role) {
          entry.note = 'no file role: the agent holds files for no input';
          console.log(`SKIP ${app.id}: ${entry.note}`);
          return;
        }
        const planned = await actions(page);
        for (const [index, action] of planned.entries()) {
          const outcome = { kind: action.kind, name: action.name };
          entry.actions.push(outcome);
          progress.phase = `${action.kind} ${action.name}`;
          outcome.result = page.isClosed() ? 'not performed: the page closed' : await attempt(context, page, app, target, action, outcome);
          // An earlier action may have hidden this control or left the page; try it once more on a fresh page.
          if (outcome.result.startsWith('not performed') || outcome.result === 'navigated away') {
            await page.close().catch(() => {});
            page = await prepare(context, app);
            const again = (await actions(page)).filter(candidate => candidate.kind === action.kind && candidate.name === action.name)[planned.slice(0, index).filter(earlier => earlier.kind === action.kind && earlier.name === action.name).length];
            outcome.result = again ? await attempt(context, page, app, target, again, outcome) : 'not performed: absent on a fresh page';
            outcome.fresh = true;
            if (outcome.result === 'navigated away') {
              await page.close().catch(() => {});
              page = await prepare(context, app);
            }
          }
        }
        const expected = SKIPS[app.id] ?? {};
        const performed = entry.actions.filter(outcome => PERFORMED.has(outcome.result));
        const kept = entry.actions.filter(outcome => outcome.result === 'FILES STILL HELD');
        assert.deepEqual(kept, [], `${app.id}: every trusted action releases the agent's files`);
        const unexplained = entry.actions.filter(outcome => !PERFORMED.has(outcome.result) && !expected[`${outcome.kind} ${outcome.name}`]);
        assert.deepEqual(unexplained, [], `${app.id}: every action is performed, or webmcp-interaction-skips.json says why not`);
        if (!performed.length) assert.ok(expected['*'], `${app.id}: no action was performed (${entry.actions.length} found), and webmcp-interaction-skips.json gives no reason under "*"`);
        for (const outcome of performed) if (expected[`${outcome.kind} ${outcome.name}`]) console.log(`NOTE ${app.id}: ${outcome.kind} ${outcome.name} was performed although webmcp-interaction-skips.json expects it not to be`);
        entry.passed = true;
        entry.checked = performed.length > 0;
        console.log(`PASS ${app.id}: ${entry.actions.map(outcome => `${outcome.kind} ${outcome.name}: ${outcome.result}${PERFORMED.has(outcome.result) ? '' : ` (expected: ${expected[`${outcome.kind} ${outcome.name}`]})`}`).join('; ') || `no action (expected: ${expected['*']})`}`);
      })()]);
    } catch (error) {
      entry.passed = false;
      entry.error = error.message;
      console.log(`FAIL ${app.id}: ${error.message.split('\n')[0]} ${JSON.stringify(entry.actions)}`);
    } finally {
      clearTimeout(timer.id);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await close();
  await rm(scratch, { recursive: true, force: true });
  if (process.env.WEBMCP_REPORT) await writeFile(process.env.WEBMCP_REPORT, `${JSON.stringify(report, null, 2)}\n`);
}
const failed = report.filter(entry => entry.passed === false).map(entry => entry.app);
const outcomes = report.flatMap(entry => entry.actions);
const released = outcomes.filter(outcome => outcome.result === 'released').length;
const skipped = report.filter(entry => entry.note).length;
console.log(`webmcp interaction: ${report.length - failed.length - skipped} apps pass, ${failed.length} fail, ${skipped} skipped; ${released} of ${outcomes.length} trusted actions performed and released the agent's files, ${outcomes.length - released} not performed`);
let unchecked = null;
try {
  requireChecked(report.filter(entry => entry.checked).length, selection, 'webmcp interaction');
} catch (error) {
  unchecked = error;
  console.log(`FAIL ${error.message}`);
}
process.exitCode = failed.length || unchecked ? 1 : 0;
