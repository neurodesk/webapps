#!/usr/bin/env node
// Whatever an app does with a control, the person using it never goes unseen by the agent's tools. For
// every app of the built site (dist/), in Chromium with Chrome's own WebMCP: the agent holds a file, the
// person performs one trusted action, and the examination must be touched or ended exactly as
// interactionEffect (webmcp/tool-inputs.js) judges the events the action sent. An action the predicate
// does not count fails. After a touch, the agent's next run must ask the person to let it continue,
// naming the held files; the test declines, which ends the examination for the next action.
//
// The actions: a pick in each classified file and folder input, a click on each remove or clear button,
// and each visible select, checkbox, text field and canvas, at most WEBMCP_INTERACTION_MAX per app (40;
// the report gives how many were found). They are listed once the app is ready: its tools registered,
// its example selectors filled, and its page quiet. An action that could not be performed, an app where
// none was, and an app with no file role (the agent holds no file there) fail unless
// test/webmcp-interaction-skips.json names them with the reason.
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
const APP_SECONDS = Number(process.env.WEBMCP_APP_SECONDS ?? 600);
const MAX_ACTIONS = Number(process.env.WEBMCP_INTERACTION_MAX ?? 40);
// dicompare, a copy of an upstream app, opens on its own home route; its workspace is one link away.
const WORKSPACE_LINKS = { dicompare: 'Open Workspace' };
const WORKSPACE = ':not(#neurodeskAgentPrompt *):not(.nd-app-bar *):not(.nd-app-utility-bar *):not(dialog.nd-app-dialog *)';
const PROMPT = 'dialog#neurodeskAgentPrompt';

// Per app, the actions expected not to be performed ("<kind> <name>": reason), or "*" for an app where
// no action can be checked.
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
const CHECKED = new Set(['touched', 'ended']);

async function tools(page) {
  const deadline = Date.now() + 90000;
  while (!(await page.evaluate(async () => Boolean(document.modelContext) && (await document.modelContext.getTools()).some(tool => tool.name === 'app_describe')))) {
    if (Date.now() > deadline) throw new Error('the tools did not register');
    await page.waitForTimeout(250);
  }
}

// The app is ready to be listed: its example selectors hold their examples and nothing has changed in the
// page for a second. Returns what did not settle, if anything, for the report.
function ready(page) {
  return page.evaluate(() => new Promise(resolve => {
    const deadline = Date.now() + 30000;
    let quietSince = Date.now();
    const observer = new MutationObserver(() => { quietSince = Date.now(); });
    observer.observe(document, { subtree: true, childList: true, attributes: true });
    const poll = () => {
      const empty = [...document.querySelectorAll('nd-example-selector')].filter(selector => selector.isConnected && !selector.examples?.length);
      const settled = !empty.length && Date.now() - quietSince >= 1000;
      if (settled || Date.now() > deadline) {
        observer.disconnect();
        resolve(settled ? null : `not settled after 30 s (${empty.length} example selector(s) without examples)`);
      } else setTimeout(poll, 100);
    };
    poll();
  }));
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
  const field = page.locator(`${PROMPT} input[type="file"]`).first();
  await field.waitFor({ state: 'attached', timeout: 10000 });
  await field.setInputFiles(Array.from({ length: count }, (_, index) => ({ name: `agent-held-${index + 1}.nii.gz`, mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [8, 8, 8] }) })));
  const held = await page.evaluate(() => Promise.race([globalThis.interactionHold, new Promise(resolve => { setTimeout(() => resolve('{}'), 10000); })]));
  return Boolean(JSON.parse(held).files);
}

// What interactionEffect makes of the events one action sends, followed as the tracker follows them:
// 'ended' once any event ends the examination, else 'touched' once any touches it, else 'kept'.
async function predict(page) {
  await page.evaluate(async href => {
    const { interactionEffect } = await import(href);
    globalThis.interactionPrediction?.stop();
    const prediction = { outcome: 'kept', touched: false };
    const judge = event => {
      const agentRunning = Boolean(globalThis.neurodeskAutomation?.running());
      const effect = interactionEffect(event, document, { touched: prediction.touched, agentRunning });
      if (effect === 'end') {
        prediction.outcome = 'ended';
        prediction.touched = false;
      } else if (effect && prediction.outcome !== 'ended') {
        prediction.outcome = 'touched';
        prediction.touched = true;
      }
    };
    const listeners = [
      ...['pointerdown', 'pointerup', 'wheel', 'keydown', 'input', 'change', 'paste', 'drop'].map(type => [window, type, true]),
      ...['nd-files', 'nd-example-status', 'nd-handoff', 'nd-run-start'].map(type => [document, type, false]),
      [window, 'neurodesk-automation-reset', false],
    ];
    for (const [target, type, capture] of listeners) target.addEventListener(type, judge, capture);
    prediction.stop = () => listeners.forEach(([target, type, capture]) => target.removeEventListener(type, judge, capture));
    globalThis.interactionPrediction = prediction;
  }, `${origin}/shell-adapters/components/webmcp/tool-inputs.js`);
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
    const named = (element, kind) => element.id || element.getAttribute('aria-label') || element.name || `${kind} ${list.length + 1}`;
    for (const input of document.querySelectorAll(`input[type="file"][data-neurodesk-input]${workspace}`)) {
      if (input.id !== 'neurodesk-input-transfer') mark(input, { kind: input.hasAttribute('webkitdirectory') ? 'folder input' : 'file input', name: named(input, 'file input'), directory: input.hasAttribute('webkitdirectory') });
    }
    const pattern = new RegExp(removers.slice(1, removers.lastIndexOf('/')), removers.slice(removers.lastIndexOf('/') + 1));
    for (const button of document.querySelectorAll(`button${workspace}`)) {
      const name = (button.getAttribute('aria-label') || button.title || button.textContent).trim();
      if (visible(button) && !button.disabled && pattern.test(name)) mark(button, { kind: 'remove or clear button', name });
    }
    for (const [kind, selector] of [['select', `select${workspace}`], ['checkbox', `input[type="checkbox"]${workspace}`], ['text field', `input[type="text"]${workspace}, input[type="number"]${workspace}, textarea${workspace}`], ['viewer canvas', `canvas${workspace}`]]) {
      for (const element of document.querySelectorAll(selector)) if (visible(element) && !element.disabled) mark(element, { kind, name: named(element, kind) });
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
  page.unsettled = await ready(page);
  return page;
}

// The parameters a run tool needs to pass its own input check; the run never starts, since the test
// declines the dialog that comes first.
function runInput(operation) {
  const parameters = {};
  for (const [name, field] of Object.entries(operation.parameters)) {
    if (!field.required) continue;
    if (field.default !== undefined) parameters[name] = field.default;
    else if (field.enum) parameters[name] = field.enum[0];
    else if (field.type === 'boolean') parameters[name] = false;
    else if (field.type === 'number' || field.type === 'integer') parameters[name] = field.minimum ?? 0;
    else if (field.type === 'array') parameters[name] = [];
    else parameters[name] = 'x';
  }
  const sources = Object.fromEntries(Object.entries(operation.inputs).filter(([, field]) => field.source !== 'files' && field.minimum > 0).map(([role]) => [role, { url: 'https://example.invalid/data' }]));
  return { parameters, ...(Object.keys(sources).length && { inputs: sources }), waitSeconds: 0 };
}

// After a touch the agent's next run asks the person; the test reads the dialog and declines.
async function resumeDeclined(page, run, held) {
  await page.evaluate(([name, input]) => {
    globalThis.interactionResume = document.modelContext.getTools()
      .then(tools => document.modelContext.executeTool(tools.find(tool => tool.name === name), input)).then(JSON.parse);
  }, [run.tool, run.input]);
  const decline = page.locator(PROMPT).getByRole('button', { name: 'Decline' });
  const shown = await decline.waitFor({ timeout: 10000 }).then(() => true, () => false);
  if (!shown) return `no resume dialog: ${JSON.stringify(await page.evaluate(() => Promise.race([globalThis.interactionResume, new Promise(resolve => { setTimeout(() => resolve(null), 2000); })])))}`;
  const listed = await page.locator(`${PROMPT} li`).allTextContents();
  await decline.click();
  const answer = await page.evaluate(() => globalThis.interactionResume);
  if (!answer.declined) return `the run did not decline: ${JSON.stringify(answer)}`;
  const missing = held.filter(name => !listed.some(item => item.endsWith(`: ${name}`)));
  return missing.length ? `the dialog did not name ${missing.join(', ')}: ${JSON.stringify(listed)}` : null;
}

// One action on the page as it stands: the agent holds a file, the person acts, the tools answer.
async function attempt(context, page, app, target, run, action, outcome) {
  if (!await hold(page, target)) return 'the agent could not hold a file';
  const held = Object.values((await call(page, 'app_describe')).inputs).flat().map(file => file.name);
  await predict(page);
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
  // The app answers an action in its own time (a remove reported with nd-files after a click); wait for
  // the page to settle rather than a fixed time.
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  if (!page.url().startsWith(`${origin}/${app.path}/`)) return 'navigated away';
  await ready(page);
  const predicted = await page.evaluate(() => {
    globalThis.interactionPrediction.stop();
    return globalThis.interactionPrediction.outcome;
  });
  const after = await call(page, 'app_describe');
  const observed = !Object.keys(after.inputs).length ? 'ended' : after.touched ? 'touched' : 'kept';
  outcome.predicted = predicted;
  if (observed === 'touched') outcome.resume = await resumeDeclined(page, run, held);
  if (predicted === 'kept') return 'NOT COUNTED';
  if (observed !== predicted) return `MISMATCH: ${observed}, the predicate says ${predicted}`;
  if (outcome.resume) return `RESUME: ${outcome.resume}`;
  return observed;
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
    const expected = SKIPS[app.id] ?? {};
    try {
      await Promise.race([deadline, (async () => {
        let page = await prepare(context, app);
        if (page.unsettled) entry.unsettled = page.unsettled;
        const describe = await call(page, 'app_describe');
        const [role, field] = Object.values(describe.operations).flatMap(operation => Object.entries(operation.inputs)).find(([, input]) => input.source === 'files') ?? [];
        if (!role) {
          entry.note = 'no file role: the agent holds files for no input';
          assert.ok(expected['*'], `${app.id}: ${entry.note}, and webmcp-interaction-skips.json gives no reason under "*"`);
          entry.passed = true;
          console.log(`SKIP ${app.id}: ${entry.note} (expected: ${expected['*']})`);
          return;
        }
        const target = { role, count: Math.max(1, field.minimum) };
        const operation = Object.values(describe.operations).find(candidate => Object.hasOwn(candidate.inputs, role));
        const run = { tool: operation.tool, input: runInput(operation) };
        const found = await actions(page);
        const planned = found.slice(0, MAX_ACTIONS);
        entry.found = found.length;
        entry.bound = MAX_ACTIONS;
        for (const [index, action] of planned.entries()) {
          const outcome = { kind: action.kind, name: action.name };
          entry.actions.push(outcome);
          progress.phase = `${action.kind} ${action.name}`;
          outcome.result = page.isClosed() ? 'not performed: the page closed' : await attempt(context, page, app, target, run, action, outcome);
          // An earlier action may have hidden this control or left the page; try it once more on a fresh page.
          if (outcome.result.startsWith('not performed') || outcome.result === 'navigated away') {
            await page.close().catch(() => {});
            page = await prepare(context, app);
            const again = (await actions(page)).filter(candidate => candidate.kind === action.kind && candidate.name === action.name)[planned.slice(0, index).filter(earlier => earlier.kind === action.kind && earlier.name === action.name).length];
            outcome.result = again ? await attempt(context, page, app, target, run, again, outcome) : 'not performed: absent on a fresh page';
            outcome.fresh = true;
            if (outcome.result === 'navigated away') {
              await page.close().catch(() => {});
              page = await prepare(context, app);
            }
          }
        }
        const checked = entry.actions.filter(outcome => CHECKED.has(outcome.result));
        const wrong = entry.actions.filter(outcome => /^(NOT COUNTED|MISMATCH|RESUME)/.test(outcome.result));
        assert.deepEqual(wrong, [], `${app.id}: every trusted action touches or ends the examination as the predicate says, and a touch asks to resume`);
        const unexplained = entry.actions.filter(outcome => !CHECKED.has(outcome.result) && !expected[`${outcome.kind} ${outcome.name}`]);
        assert.deepEqual(unexplained, [], `${app.id}: every action is performed, or webmcp-interaction-skips.json says why not`);
        if (!checked.length) assert.ok(expected['*'], `${app.id}: no action was performed (${entry.actions.length} found), and webmcp-interaction-skips.json gives no reason under "*"`);
        for (const outcome of checked) if (expected[`${outcome.kind} ${outcome.name}`]) console.log(`NOTE ${app.id}: ${outcome.kind} ${outcome.name} was performed although webmcp-interaction-skips.json expects it not to be`);
        entry.passed = true;
        entry.checked = checked.length > 0;
        const bound = found.length > planned.length ? ` (${planned.length} of ${found.length} found, bound ${MAX_ACTIONS})` : '';
        console.log(`PASS ${app.id}${bound}: ${entry.actions.map(outcome => `${outcome.kind} ${outcome.name}: ${outcome.result}${CHECKED.has(outcome.result) ? '' : ` (expected: ${expected[`${outcome.kind} ${outcome.name}`]})`}`).join('; ') || `no action (expected: ${expected['*']})`}`);
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
const touched = outcomes.filter(outcome => outcome.result === 'touched').length;
const ended = outcomes.filter(outcome => outcome.result === 'ended').length;
const skipped = report.filter(entry => entry.note).length;
const bounded = report.filter(entry => entry.found > entry.bound).map(entry => `${entry.app} ${entry.bound} of ${entry.found}`);
console.log(`webmcp interaction: ${report.length - failed.length - skipped} apps pass, ${failed.length} fail, ${skipped} skipped; ${outcomes.length} actions: ${touched} touched (each asked to resume), ${ended} ended, ${outcomes.length - touched - ended} not performed${bounded.length ? `; bounded: ${bounded.join(', ')}` : ''}`);
let unchecked = null;
try {
  requireChecked(report.filter(entry => entry.checked).length, selection, 'webmcp interaction');
} catch (error) {
  unchecked = error;
  console.log(`FAIL ${error.message}`);
}
process.exitCode = failed.length || unchecked ? 1 : 0;
