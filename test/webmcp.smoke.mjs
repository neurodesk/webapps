#!/usr/bin/env node
// Drives every app of the built composite site (dist/) through its WebMCP tools in Chromium, with
// Chrome's own WebMCP implementation switched on for testing (getTools and executeTool, as a browser
// agent calls them). An app fails when the browser has no WebMCP of its own; WEBMCP_STAND_IN=1
// installs a stand-in model context with the same calls instead, for a Chromium without it.
//
// Each app, at desktop and phone width: the full tool set registers, app_describe answers with the
// contract, user_ask and inputs_request_files render their dialogs and return what the person chose,
// and the Privacy dialog carries the shared agent statement. A browser without WebMCP loads no WebMCP
// module. Every light-DOM file input, folder inputs included, lists the files picked in it in pageFiles,
// or what the app reported it holds instead (nd-files). This checks what the tools offer the person to
// confirm, not what the app accepted: an entry the app refused is still listed, and the person decides.
// Inputs inside shadow roots are counted, not checked.
//
// WEBMCP_RUNS=1 also loads each loadable example (WEBMCP_EXAMPLES=first: only the first), runs it with
// the tool and parameters app_describe gives and saves an output, through the tools only. Every run must
// complete, unless test/webmcp-run-skips.json names the app with its expected outcome ("timed out",
// "run failed" with an error pattern, or "no loadable example") and the reason; any other outcome fails.
//
//   pnpm build && node test/webmcp.smoke.mjs
//   SMOKE_APPS=brain-extraction,n4 WEBMCP_RUNS=1 WEBMCP_REPORT=report.json WEBMCP_SHOTS=shots node test/webmcp.smoke.mjs
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { exampleCachePath } from '../scripts/lib/example-asset-cache.mjs';
import { auditAppExamples } from '../scripts/lib/webmcp-examples.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';
import { syntheticNifti } from '../test-utils/nifti-fixture.mjs';

const FIXED_TOOLS = ['app_describe', 'inputs_request_files', 'inputs_use_page_files', 'inputs_load_example', 'runs_get', 'runs_cancel', 'outputs_download', 'user_ask',
  'viewers_list', 'viewers_state', 'viewers_crosshair', 'viewers_tab', 'viewers_regions', 'viewers_volumes', 'viewers_display', 'viewers_niivue'];
const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
// Chromium keeps only the last --enable-features, so the WebMCP feature joins the GPU ones.
const features = names => `--enable-features=${[...(process.platform === 'linux' ? ['Vulkan'] : []), ...names].join(',')}`;
const GPU_ARGS = process.platform === 'linux'
  ? ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--use-vulkan=swiftshader', '--disable-vulkan-surface']
  : [];
const RUN_SECONDS = Number(process.env.WEBMCP_RUN_SECONDS ?? 900);
const STAND_IN = process.env.WEBMCP_STAND_IN === '1';
const RUN_SKIPS = JSON.parse(await readFile(new URL('./webmcp-run-skips.json', import.meta.url), 'utf8'));
const ALL_EXAMPLES = process.env.WEBMCP_EXAMPLES !== 'first';

const registry = await loadAppsRegistry();
const requested = new Set((process.env.SMOKE_APPS ?? '').split(',').filter(Boolean));
const apps = requested.size ? registry.apps.filter(({ id }) => requested.has(id)) : registry.apps;
assert.equal(apps.length, requested.size || registry.apps.length, 'every SMOKE_APPS entry names an app');
const shots = process.env.WEBMCP_SHOTS;
if (shots) await mkdir(shots, { recursive: true });
const cache = process.env.EXAMPLE_ASSET_CACHE;
const dist = join(repoRoot, 'dist');

// Installed before any page script when the browser has no model context of its own.
function standInModelContext() {
  if (document.modelContext || !isSecureContext) return;
  const tools = new Map();
  const modelContext = {
    standIn: true,
    async registerTool(tool, { signal } = {}) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) || !tool.description) throw new DOMException(`Invalid tool: ${tool.name}`, 'InvalidStateError');
      if (tools.has(tool.name)) throw new DOMException(`Duplicate tool: ${tool.name}`, 'InvalidStateError');
      tools.set(tool.name, tool);
      signal?.addEventListener('abort', () => tools.delete(tool.name));
    },
    async getTools() {
      return [...tools.values()];
    },
    async executeTool(tool, input = {}, { signal } = {}) {
      return JSON.stringify(await tool.execute(input, { signal: signal ?? new AbortController().signal }));
    },
  };
  Object.defineProperty(Document.prototype, 'modelContext', { configurable: true, get: () => modelContext });
}

// Tool calls stay in the page, so one can wait on a dialog while the test answers it.
async function startCall(page, name, input = {}) {
  const id = await page.evaluate(async ([name, input]) => {
    const calls = (globalThis.webMcpSmokeCalls ??= []);
    const tool = (await document.modelContext.getTools()).find(candidate => candidate.name === name);
    calls.push(tool ? document.modelContext.executeTool(tool, input) : Promise.reject(new Error(`No tool ${name}`)));
    return calls.length - 1;
  }, [name, input]);
  return async () => JSON.parse(await page.evaluate(index => globalThis.webMcpSmokeCalls[index], id));
}
const call = async (page, name, input) => (await startCall(page, name, input))();

// waitForFunction does not await an async predicate, and getTools is async.
async function until(page, predicate, argument, timeout) {
  const deadline = Date.now() + timeout;
  while (!(await page.evaluate(predicate, argument))) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${predicate}`);
    await delay(250);
  }
}

async function openApp(context, app) {
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/${app.path}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  return { page, errors };
}

async function expectedTools(app) {
  const contract = JSON.parse(await readFile(join(dist, app.path, 'automation.json'), 'utf8'));
  return { contract, names: [...FIXED_TOOLS, ...Object.keys(contract.operations).map(name => `run_${name.replaceAll('-', '_')}`)].sort() };
}

async function screenshot(page, name) {
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
}

async function promptsFit(page, label) {
  const dialog = page.locator('dialog#neurodeskAgentPrompt');
  const box = await dialog.boundingBox();
  const { width } = page.viewportSize();
  assert.ok(box && box.x >= 0 && box.x + box.width <= width + 1, `${label}: the dialog fits the ${width}px viewport`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no horizontal page scroll`);
}

async function checkPrompts(page, app, contract, viewport) {
  const label = `${app.id}/${viewport.width}`;
  const dialog = page.locator('dialog#neurodeskAgentPrompt');
  const question = await startCall(page, 'user_ask', { question: 'Which series should I analyse?', options: ['T1-weighted', 'T2-weighted'] });
  await dialog.getByRole('button', { name: 'T2-weighted' }).waitFor({ timeout: 10000 });
  assert.match(await dialog.textContent(), /An AI agent you started in this browser sent this request/);
  await promptsFit(page, `${label} user_ask`);
  await screenshot(page, `${app.id}-${viewport.width}-ask`);
  await dialog.getByRole('button', { name: 'T2-weighted' }).click();
  assert.deepEqual(await question(), { answer: 'T2-weighted' }, label);

  const role = Object.values(contract.operations).flatMap(operation => Object.entries(operation.inputs)).find(([, field]) => field.source === 'files')?.[0];
  if (!role) return;
  const request = await startCall(page, 'inputs_request_files', { role, message: 'Choose the scan to analyse.' });
  await dialog.getByText('Choose files').first().waitFor({ timeout: 10000 });
  await promptsFit(page, `${label} inputs_request_files`);
  await screenshot(page, `${app.id}-${viewport.width}-files`);
  await page.keyboard.press('Escape');
  assert.deepEqual(await request(), { declined: true }, label);
}

async function checkPrivacy(page, app) {
  await page.locator('.nd-app-bar [data-neurodesk-shell-control="privacy"]').first().click();
  const block = page.locator('[data-neurodesk-app-info="privacy"]').filter({ visible: true });
  await block.first().waitFor({ timeout: 10000 });
  assert.match(await block.first().textContent(), /Nothing reaches the agent until it calls a tool/, `${app.id}: Privacy`);
  await page.keyboard.press('Escape');
}

// Many apps clear an input once they have read it, and some reset their examination as they load.
// Whatever an app does, the files picked in a page input stay listed in pageFiles, which
// inputs_use_page_files shows the person before the agent gets them, unless the app reports with
// nd-files what the input holds instead; then pageFiles lists exactly that.
async function checkPageFiles(page, app) {
  await page.evaluate(() => {
    globalThis.webMcpSmokeReported = new Map();
    document.addEventListener('nd-files', event => {
      if (event.detail?.files?.[Symbol.iterator]) globalThis.webMcpSmokeReported.set(event.target, [...event.detail.files].map(file => file.name));
    }, true);
  });
  const inputs = page.locator('input[type="file"][data-neurodesk-input]:not(#neurodesk-input-transfer)');
  const offered = [];
  let shadowed = 0;
  for (let index = 0; index < await inputs.count(); index += 1) {
    const input = inputs.nth(index);
    const where = await input.evaluate(element => ({ light: element.getRootNode() === document && !element.closest('#neurodeskAgentPrompt'), folder: element.hasAttribute('webkitdirectory'), key: element.id }));
    if (!where.light) continue;
    const name = `webmcp-page-file-${index + 1}.nii.gz`;
    const file = { name, mimeType: 'application/gzip', buffer: syntheticNifti({ dims: [8, 8, 8] }) };
    if (where.folder) {
      const folder = join(folders, `${app.id}-${index + 1}`);
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, name), file.buffer);
      await input.setInputFiles(folder);
    } else await input.setInputFiles(file);
    offered.push({ input, name, key: where.key, folder: where.folder });
  }
  shadowed = await page.evaluate(() => {
    let count = 0;
    const walk = root => root.querySelectorAll('*').forEach(element => {
      if (element.shadowRoot) {
        count += element.shadowRoot.querySelectorAll('input[type="file"]').length;
        walk(element.shadowRoot);
      }
    });
    walk(document);
    return count;
  });
  if (!offered.length) return { checked: 0, shadowed };
  await delay(1500);
  const { pageFiles } = await call(page, 'app_describe');
  const wrong = [];
  for (const { input, name, key, folder } of offered) {
    const reported = await input.evaluate(element => globalThis.webMcpSmokeReported.get(element) ?? null);
    const listed = pageFiles.find(entry => entry.input === key)?.files.map(file => file.name) ?? [];
    const expected = reported ?? [name];
    if (JSON.stringify(listed) !== JSON.stringify(expected)) wrong.push({ input: key, folder, picked: name, reported, listed });
  }
  assert.deepEqual(wrong, [], `${app.id}: every page input lists the files picked in it, or what the app reported (pageFiles ${JSON.stringify(pageFiles)})`);
  return { checked: offered.length, shadowed };
}

// The outcome of one example run, which webmcp-run-skips.json may expect for its app.
function expected(app, run) {
  const skip = RUN_SKIPS[app.id];
  if (!skip) return false;
  if (run.outcome !== skip.expect) return false;
  return !skip.error || new RegExp(skip.error, 'i').test(JSON.stringify(run.error ?? ''));
}

async function runExample(page, app, example, progress) {
  const operation = example.tool;
  progress.phase = `loading example ${example.id}`;
  const loaded = await call(page, 'inputs_load_example', { exampleId: example.id });
  if (loaded.error) return { outcome: 'example failed to load', example: example.id, error: loaded.error };
  progress.phase = `running ${operation} on ${example.id}`;
  const started = Date.now();
  let run = await call(page, operation, { parameters: example.parameters ?? {}, waitSeconds: Math.min(RUN_SECONDS, 600) });
  while (run.state === 'running' && Date.now() - started < RUN_SECONDS * 1000) run = await call(page, 'runs_get', { runId: run.runId, waitSeconds: 60 });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (run.state === 'running') {
    await call(page, 'runs_cancel', {});
    return { outcome: 'timed out', example: example.id, operation, seconds };
  }
  if (run.state !== 'succeeded') return { outcome: 'run failed', example: example.id, operation, seconds, error: run.error ?? run };
  progress.phase = `saving an output of ${example.id}`;
  // A viewer operation may write no file; its report is still an output.
  const [artifactId, artifact] = Object.entries(run.report.artifacts)[0] ?? ['report', { filename: 'report.json' }];
  const download = page.waitForEvent('download', { timeout: 60000 });
  const saved = await call(page, 'outputs_download', { runId: run.runId, artifactId });
  assert.deepEqual(saved, { runId: run.runId, artifactId }, `${app.id}: outputs_download`);
  assert.equal((await download).suggestedFilename(), artifact.filename, `${app.id}: the browser saved the artifact`);
  return { outcome: 'completed', example: example.id, operation, seconds, artifacts: Object.keys(run.report.artifacts), saved: artifact.filename };
}

const folders = await mkdtemp(join(tmpdir(), 'webmcp-smoke-'));
const { origin, close } = await serveSite(dist);
const report = [];
const flagged = await chromium.launch({ args: [...GPU_ARGS, features(['WebMCPTesting'])] });
const plain = await chromium.launch({ args: [...GPU_ARGS, features([])] });
async function flaggedContext() {
  const context = await flagged.newContext({ acceptDownloads: true });
  if (STAND_IN) await context.addInitScript(standInModelContext);
  await context.route(/googletagmanager\.com|google-analytics\.com|cloudflareinsights\.com/, route => route.abort());
  if (cache) {
    await context.route(url => existsSync(exampleCachePath(cache, url.href)), async route => route.fulfill({ body: await readFile(exampleCachePath(cache, route.request().url())) }));
  }
  return context;
}

// A run in its own context: a page that stops answering (a stalled download, a busy worker) is closed
// with its context instead of stalling the catalogue.
async function runInPage(app, example) {
  const context = await flaggedContext();
  const progress = { phase: 'opening the page' };
  const attempt = (async () => {
    const { page } = await openApp(context, app);
    await until(page, async () => (await document.modelContext.getTools()).some(tool => tool.name === 'app_describe'), undefined, 90000);
    return runExample(page, app, example, progress);
  })();
  const deadline = delay((RUN_SECONDS + 180) * 1000, undefined, { ref: false }).then(() => ({ outcome: `no answer while ${progress.phase}` }));
  try {
    return await Promise.race([attempt, deadline]);
  } catch (error) {
    return { outcome: `failed while ${progress.phase}`, error: { message: error.message } };
  } finally {
    attempt.catch(() => {});
    await context.close();
  }
}

try {
  const context = await flaggedContext();
  const without = await plain.newContext();
  for (const app of apps) {
    const entry = { app: app.id };
    report.push(entry);
    try {
      const { contract, names } = await expectedTools(app);
      for (const viewport of WIDTHS) {
        const { page, errors } = await openApp(context, app);
        try {
          await page.setViewportSize(viewport);
          entry.api = await page.evaluate(() => (!document.modelContext ? 'none' : document.modelContext.standIn ? 'stand-in' : 'chrome'));
          assert.notEqual(entry.api, 'none', `${app.id}: this Chromium has no WebMCP; use a build with WebMCPTesting, or WEBMCP_STAND_IN=1`);
          await until(page, async count => (await document.modelContext.getTools()).length >= count, names.length, 90000);
          const registered = (await page.evaluate(() => document.modelContext.getTools().then(tools => tools.map(tool => tool.name)))).sort();
          assert.deepEqual(registered, names, `${app.id}: the full tool set`);
          const describe = await call(page, 'app_describe');
          assert.equal(describe.app, app.id);
          assert.deepEqual(Object.keys(describe.operations).sort(), Object.keys(contract.operations).sort());
          entry.examples = describe.examples.map(example => example.id);
          entry.unavailableExamples = describe.unavailableExamples.map(example => example.id);
          const audit = await auditAppExamples(app.id);
          assert.deepEqual(entry.examples.sort(), audit.examples.filter(example => !example.unavailable).map(example => example.id).sort(), `${app.id}: every loadable example is offered`);
          await checkPrompts(page, app, contract, viewport);
          if (viewport === WIDTHS[0]) {
            await checkPrivacy(page, app);
            entry.pageInputs = await checkPageFiles(page, app);
            entry.describe = describe;
          }
          entry.pageErrors = errors;
        } finally {
          await page.close();
        }
      }
      const page = await without.newPage();
      const loaded = [];
      page.on('request', request => { if (/\/webmcp\/|agentPrompt\.js/.test(request.url())) loaded.push(request.url()); });
      await page.goto(`${origin}/${app.path}/`, { waitUntil: 'load', timeout: 90000 });
      assert.equal(await page.evaluate(() => 'modelContext' in document), false);
      assert.deepEqual(loaded, [], `${app.id}: a browser without WebMCP loads none of its modules`);
      await page.close();
      if (process.env.WEBMCP_RUNS) {
        const loadable = entry.describe.examples;
        delete entry.describe;
        entry.runs = [];
        if (!loadable.length) entry.runs.push({ outcome: 'no loadable example', reasons: entry.unavailableExamples });
        for (const example of ALL_EXAMPLES ? loadable : loadable.slice(0, 1)) entry.runs.push(await runInPage(app, example));
        const unexpected = entry.runs.filter(run => run.outcome !== 'completed' && !expected(app, run));
        if (unexpected.length) throw new Error(`example runs ${unexpected.map(run => `${run.example ?? ''} ${run.outcome}: ${JSON.stringify(run.error ?? run.reasons ?? '')}`).join('; ')}`);
        if (RUN_SKIPS[app.id] && entry.runs.every(run => run.outcome === 'completed')) console.log(`NOTE ${app.id}: completed although webmcp-run-skips.json expects ${RUN_SKIPS[app.id].expect}`);
      }
      delete entry.describe;
      entry.passed = true;
      const runs = entry.runs?.map(run => `${run.example ?? ''} ${run.outcome}${run.seconds !== undefined ? ` in ${run.seconds} s` : ''}`).join(', ');
      console.log(`PASS ${app.id}: ${names.length} tools (${entry.api}), examples ${entry.examples.join(', ') || 'none'}, ${entry.pageInputs?.checked ?? 0} page inputs checked${entry.pageInputs?.shadowed ? `, ${entry.pageInputs.shadowed} in shadow roots not covered` : ''}${runs ? `; runs: ${runs}` : ''}`);
    } catch (error) {
      entry.passed = false;
      entry.error = error.message;
      console.error(`FAIL ${app.id}: ${error.message}`);
    }
  }
} finally {
  await flagged.close();
  await plain.close();
  await close();
  await rm(folders, { recursive: true, force: true });
  if (process.env.WEBMCP_REPORT) await writeFile(process.env.WEBMCP_REPORT, `${JSON.stringify(report, null, 2)}\n`);
}
const failed = report.filter(entry => !entry.passed).map(entry => entry.app);
assert.deepEqual(failed, [], 'WebMCP registration, describe and prompts');
