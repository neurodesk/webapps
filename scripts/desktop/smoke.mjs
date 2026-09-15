import { _electron as electron } from '@playwright/test';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { verifyWorkflow } from './workflows.mjs';
import { verifyBundle } from '../../packages/desktop/src/bundle.js';

const root = resolve(import.meta.dirname, '../..');
const resources = process.env.NEURODESK_BUNDLE || join(root, 'packages/desktop/resources');
const report = process.env.NEURODESK_TEST_REPORT || await mkdtemp(join(tmpdir(), 'neurodesk-desktop-report-'));
await mkdir(report, { recursive: true });
await verifyBundle(resources);
const require = createRequire(join(root, 'packages/desktop/package.json'));
const executablePath = process.env.NEURODESK_EXECUTABLE || require('electron');
const bundle = JSON.parse(await readFile(join(resources, 'manifest.json')));
const environment = { ...process.env };
delete environment.ELECTRON_RUN_AS_NODE;
const results = [];
for (const app of bundle.apps.filter(app => !process.env.NEURODESK_TEST_APP || process.env.NEURODESK_TEST_APP.split(',').includes(app.id))) {
  const userData = await mkdtemp(join(tmpdir(), `neurodesk-${app.id}-`));
  const errors = [];
  const missing = [];
  let desktop;
  try {
    desktop = await electron.launch({
      executablePath,
      args: process.env.NEURODESK_EXECUTABLE ? [] : [join(root, 'packages/desktop')],
      env: { ...environment, NEURODESK_BUNDLE: resources, NEURODESK_APP: app.id, NEURODESK_USER_DATA: userData, NEURODESK_DOWNLOADS: join(report, app.id, 'downloads') },
      timeout: 60000,
    });
    const page = await desktop.firstWindow();
    page.on('console', message => console.log(`${app.id} ${message.type()}: ${message.text()}`));
    page.on('pageerror', error => errors.push(error.message));
    page.on('response', response => { if (response.status() >= 400 && !new URL(response.url()).pathname.startsWith('/_local/')) missing.push(`${response.status()} ${response.url()}`); });
    await page.waitForLoadState('domcontentloaded');
    const enter = page.locator('#enterAppButton:visible, #landingLaunch:visible');
    if (await enter.count()) await enter.first().click();
    if (await page.locator('#welcomeLater:visible').count()) await page.locator('#welcomeLater').click();
    await page.locator('[data-neurodesk-shell-control=standalone]:visible').first().click({ timeout: 60000 });
    await page.locator('#neurodeskStandaloneDialog').waitFor({ state: 'visible' });
    await page.screenshot({ path: join(report, `${app.id}.png`) });
    await page.locator('#neurodeskStandaloneDialog').getByRole('button', { name: 'Close', exact: true }).click();
    const workflow = process.env.NEURODESK_WORKFLOWS ? await verifyWorkflow(app.id, page, { root, resources, desktop }) : null;
    const blocked = await desktop.evaluate(() => globalThis.neurodeskOffline.blockedRequests);
    results.push({ app: app.id, passed: !errors.length && !missing.length && !blocked.length, errors, missing, blocked, workflow });
  } catch (error) {
    errors.push(error.message);
    results.push({ app: app.id, passed: false, errors, missing });
  } finally {
    if (desktop && errors.length) {
      try { await (await desktop.firstWindow()).screenshot({ path: join(report, `${app.id}-failure.png`) }); } catch {}
    }
    await desktop?.close();
  }
  console.log(JSON.stringify(results.at(-1)));
}
await writeFile(join(report, 'startup.json'), `${JSON.stringify(results, null, 2)}\n`);
console.log(`Desktop test report: ${report}`);
if (results.some(result => !result.passed)) process.exitCode = 1;
