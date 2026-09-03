#!/usr/bin/env node
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from '@playwright/test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { verifyMuscleMapFullPipeline } from './musclemap-full-pipeline-smoke.mjs';
import { verifyMuscleMapThreads } from './multithreaded-ort-smoke.mjs';

const dist = join(repoRoot, 'dist');
const registry = await loadAppsRegistry();
const requestedAppIds = new Set((process.env.SMOKE_APPS ?? '').split(',').filter(Boolean));
const skipScientificWorkflows = process.env.SMOKE_SKIP_SCIENTIFIC === '1';
const appsUnderTest = requestedAppIds.size
  ? registry.apps.filter(({ id }) => requestedAppIds.has(id))
  : registry.apps;
if (appsUnderTest.length !== (requestedAppIds.size || registry.apps.length)) {
  const found = new Set(appsUnderTest.map(({ id }) => id));
  const missing = [...requestedAppIds].filter((id) => !found.has(id));
  throw new Error(`Unknown SMOKE_APPS entries: ${missing.join(', ')}`);
}
const mimeTypes = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.wasm', 'application/wasm'],
]);

function resolveRequest(pathname) {
  const decoded = decodeURIComponent(pathname);
  const relative = normalize(decoded).replace(/^[/\\]+/, '');
  if (relative.startsWith('..')) return null;
  return join(dist, relative);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/qsm-nav.js') {
      // QSMbly deliberately selects a local ecosystem-bar script on localhost.
      // Production uses qsmxt.github.io; this fixture keeps the composite smoke
      // focused on the deployed subpath without requiring that external script.
      const body = '/* QSM ecosystem navigation smoke fixture */';
      response.writeHead(200, {
        'content-length': Buffer.byteLength(body),
        'content-type': 'text/javascript; charset=utf-8',
      }).end(body);
      return;
    }
    let path = resolveRequest(url.pathname);
    if (!path) {
      response.writeHead(400).end('Bad request');
      return;
    }

    let metadata;
    try {
      metadata = await stat(path);
    } catch {
      response.writeHead(404).end('Not found');
      return;
    }

    if (metadata.isDirectory()) {
      if (!url.pathname.endsWith('/')) {
        response.writeHead(308, { location: `${url.pathname}/${url.search}` }).end();
        return;
      }
      path = join(path, 'index.html');
      metadata = await stat(path);
    }

    response.writeHead(200, {
      'content-length': metadata.size,
      'content-type': mimeTypes.get(extname(path)) ?? 'application/octet-stream',
      'cross-origin-embedder-policy': 'credentialless',
      'cross-origin-opener-policy': 'same-origin',
      'x-content-type-options': 'nosniff',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path).pipe(response);
  } catch (error) {
    response.writeHead(500).end(error.message);
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const address = server.address();
const origin = `http://127.0.0.1:${address.port}`;
const browser = await chromium.launch({ headless: true });
const failures = [];

try {
  const privacyContext = await browser.newContext();
  await privacyContext.addInitScript(() => {
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' });
  });
  const privacyPage = await privacyContext.newPage();
  let blockedGoogleRequests = 0;
  privacyPage.on('request', (request) => {
    if (/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/.test(request.url())) {
      blockedGoogleRequests += 1;
    }
  });
  await privacyPage.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  await privacyPage.waitForTimeout(100);
  if (await privacyPage.locator('script[data-neurodesk-ga4]').count()) {
    failures.push('Do Not Track still injected the GA4 loader');
  }
  if (blockedGoogleRequests) failures.push(`Do Not Track allowed ${blockedGoogleRequests} Google analytics requests`);
  if (await privacyPage.evaluate(() => Boolean(window.dataLayer))) failures.push('Do Not Track still created dataLayer');
  await privacyContext.close();

  const themeContext = await browser.newContext();
  const themePage = await themeContext.newPage();
  await themePage.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/,
    (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await themePage.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const themeToggle = themePage.locator('[data-neurodesk-theme-toggle]');
  if (await themePage.locator('html[data-neurodesk-theme="dark"]').count() !== 1) {
    failures.push('landing page does not default to dark theme');
  }
  await themeToggle.click();
  if (await themePage.locator('html[data-neurodesk-theme="light"]').count() !== 1) {
    failures.push('landing page theme toggle did not switch to light');
  }
  await themePage.reload({ waitUntil: 'domcontentloaded' });
  if (await themePage.locator('html[data-neurodesk-theme="light"]').count() !== 1) {
    failures.push('landing page did not restore the saved light theme');
  }
  const firstApp = registry.apps[0];
  await themePage.goto(`${origin}/${firstApp.path}/`, { waitUntil: 'domcontentloaded' });
  await themePage.waitForTimeout(100);
  if (await themePage.locator('html[data-neurodesk-theme="light"]').count() !== 1) {
    failures.push(`${firstApp.id}: did not inherit the saved light theme`);
  }
  await themePage.locator('[data-neurodesk-theme-toggle]').first().click();
  if (await themePage.locator('html[data-neurodesk-theme="dark"]').count() !== 1) {
    failures.push(`${firstApp.id}: app theme toggle did not switch back to dark`);
  }
  await themePage.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  if (await themePage.locator('html[data-neurodesk-theme="dark"]').count() !== 1) {
    failures.push('landing page did not inherit the dark theme selected in an app');
  }
  await themeContext.close();

  const landing = await browser.newPage();
  await landing.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/,
    (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
  await landing.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
  const cards = await landing.locator('a.app-card').count();
  const landingText = await landing.locator('body').innerText();
  if (cards !== registry.apps.length) failures.push(`landing page has ${cards} app cards, expected ${registry.apps.length}`);
  if (landingText.includes('Models and large scientific assets are delivered from Hugging Face')) {
    failures.push('landing page still contains the removed scientific-assets message');
  }
  const landingGa = await landing.locator('script[data-neurodesk-ga4="G-4Z9774J59Y"]').count();
  if (landingGa !== 1) failures.push(`landing page has ${landingGa} shared GA4 loaders, expected 1`);
  const landingEvents = await landing.evaluate(() => (window.dataLayer ?? []).map((entry) => entry[0]));
  if (landingEvents.filter((name) => name === 'js').length !== 1
      || landingEvents.filter((name) => name === 'config').length !== 1
      || landingEvents.includes('event')) {
    failures.push(`landing analytics calls are out of contract: ${landingEvents.join(',')}`);
  }
  if (!(await landing.locator('#analytics').isVisible())) failures.push('landing analytics section is not visible');

  await landing.locator('#app-search').fill('DICOM');
  const dicomMatches = await landing.locator('[data-app-card]:not([hidden])').count();
  if (dicomMatches !== 2) failures.push(`landing search found ${dicomMatches} DICOM apps, expected 2`);

  await landing.locator('#clear-search').click();
  await landing.locator('[data-category-filter="quality-annotation"]').click();
  const qualityMatches = await landing.locator('[data-app-card]:not([hidden])').count();
  const expectedQualityMatches = registry.apps.filter(({ category }) => category === 'quality-annotation').length;
  if (qualityMatches !== expectedQualityMatches) {
    failures.push(`quality category has ${qualityMatches} visible apps, expected ${expectedQualityMatches}`);
  }

  await landing.locator('[data-category-filter="all"]').click();
  await landing.locator('#app-search').fill('no-such-neurodesk-app');
  if (!(await landing.locator('#no-results').isVisible())) failures.push('landing search does not show its empty state');
  await landing.locator('#reset-filters').click();
  const resetMatches = await landing.locator('[data-app-card]:not([hidden])').count();
  if (resetMatches !== registry.apps.length) failures.push(`landing reset shows ${resetMatches} apps, expected ${registry.apps.length}`);
  await landing.close();

  for (const app of appsUnderTest) {
    const page = await browser.newPage();
    await page.route(/googletagmanager\.com|google-analytics\.com|analytics\.google\.com/,
      (route) => route.fulfill({ status: 200, contentType: 'application/javascript', body: '' }));
    const pageErrors = [];
    const responseErrors = [];
    const subpathLeaks = [];
    let returningHome = false;

    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('response', (response) => {
      const url = new URL(response.url());
      if (url.origin === origin && response.status() >= 400) {
        responseErrors.push(`${response.status()} ${url.pathname}`);
      }
    });
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (url.origin !== origin || url.pathname === `/favicon.ico`) return;
      if (url.pathname.startsWith('/_runtime/')) return;
      if (url.pathname === '/app-theme.css') return;
      if (url.pathname === '/theme.js') return;
      if (url.pathname === '/app-shell.js') return;
      if (url.pathname.startsWith('/shell-adapters/')) return;
      if (url.pathname === '/analytics.js') return;
      if (app.id === 'qsmbly' && url.pathname === '/qsm-nav.js') return;
      if (returningHome && url.pathname === '/') return;
      if (url.pathname !== `/${app.path}/` && !url.pathname.startsWith(`/${app.path}/`)) {
        subpathLeaks.push(url.pathname);
      }
    });

    const response = await page.goto(`${origin}/${app.path}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(app.id === 'seedseg' ? 4_000 : 1_000);
    const title = await page.title();
    const bodyText = await page.locator('body').innerText();
    const themeLinks = await page.locator('link[data-neurodesk-app-theme]').count();
    const themeScripts = await page.locator('script[data-neurodesk-theme-controller]').count();
    const shellScripts = await page.locator('script[data-neurodesk-app-shell]').count();
    const analyticsScripts = await page.locator('script[data-neurodesk-ga4="G-4Z9774J59Y"]').count();
    const visibleTopBars = page.locator('.nd-app-bar:visible');
    const topBarRows = await page.evaluate(() => [...new Set([...document.querySelectorAll('.nd-app-bar')]
      .filter((bar) => bar.getBoundingClientRect().height > 0)
      .map((bar) => Math.round(bar.getBoundingClientRect().top)))]);
    const themeState = await page.evaluate(() => ({
      appId: document.documentElement.dataset.neurodeskApp,
      theme: document.documentElement.dataset.neurodeskTheme,
      colorScheme: getComputedStyle(document.documentElement).colorScheme,
      brandPrimary: getComputedStyle(document.documentElement).getPropertyValue('--nd-brand-primary').trim(),
      pageBackground: getComputedStyle(document.body).backgroundColor,
    }));
    const darkStartPage = await page.evaluate(() => {
      const startPage = [...document.querySelectorAll('.start-page')]
        .find((element) => element.getBoundingClientRect().height > 0);
      if (!startPage) return null;
      return getComputedStyle(startPage).backgroundColor;
    });
    const darkStartPageContrast = await page.evaluate(() => {
      const pairings = [
        ['.start-hero h2', '.start-page'],
        ['.start-intro', '.start-page'],
        ['.start-local-badge', '.start-local-badge'],
        ['.start-local-panel li', '.start-local-panel'],
        ['.start-step h4', '.start-step'],
        ['.start-step p', '.start-step'],
      ];
      const rgba = (value) => {
        const channels = (value.match(/[\d.]+/g) ?? []).map(Number);
        return [channels[0], channels[1], channels[2], channels[3] ?? 1];
      };
      const composite = (foreground, background) => {
        const alpha = foreground[3] + background[3] * (1 - foreground[3]);
        return [0, 1, 2].map((index) => (
          foreground[index] * foreground[3]
          + background[index] * background[3] * (1 - foreground[3])
        ) / alpha).concat(alpha);
      };
      const effectiveBackground = (element) => {
        const parent = element.parentElement
          ? effectiveBackground(element.parentElement)
          : [255, 255, 255, 1];
        return composite(rgba(getComputedStyle(element).backgroundColor), parent);
      };
      const luminance = (value) => value.slice(0, 3).map((channel) => channel / 255)
        .map((channel) => channel <= 0.04045
          ? channel / 12.92
          : ((channel + 0.055) / 1.055) ** 2.4)
        .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
      const contrast = (foreground, background) => {
        const values = [luminance(foreground), luminance(background)];
        return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
      };
      return pairings.flatMap(([textSelector, backgroundSelector]) => {
        const textElement = document.querySelector(textSelector);
        const backgroundElement = textElement?.closest(backgroundSelector);
        if (!textElement || !backgroundElement || textElement.getBoundingClientRect().height === 0) return [];
        const foreground = rgba(getComputedStyle(textElement).color);
        const background = effectiveBackground(backgroundElement);
        return [{
          selector: textSelector,
          foreground: getComputedStyle(textElement).color,
          background: background.slice(0, 3).map(Math.round).join(' '),
          ratio: contrast(foreground, background),
        }];
      });
    });

    if (!response?.ok()) failures.push(`${app.id}: document returned ${response?.status() ?? 'no response'}`);
    if (!title.trim()) failures.push(`${app.id}: empty document title`);
    if (!bodyText.trim()) failures.push(`${app.id}: empty rendered body`);
    if (themeLinks !== 1) failures.push(`${app.id}: found ${themeLinks} hosted theme links, expected 1`);
    if (themeScripts !== 1) failures.push(`${app.id}: found ${themeScripts} theme controllers, expected 1`);
    if (shellScripts !== 1) failures.push(`${app.id}: found ${shellScripts} shared app-shell scripts, expected 1`);
    if (analyticsScripts !== 1) failures.push(`${app.id}: found ${analyticsScripts} shared GA4 loaders, expected 1`);
    const analyticsCalls = await page.evaluate(() => (window.dataLayer ?? []).map((entry) => entry[0]));
    if (analyticsCalls.filter((name) => name === 'js').length !== 1
        || analyticsCalls.filter((name) => name === 'config').length !== 1
        || analyticsCalls.includes('event')) {
      failures.push(`${app.id}: analytics calls are out of contract: ${analyticsCalls.join(',')}`);
    }
    if (await visibleTopBars.count() < 1) failures.push(`${app.id}: no shared top bar is visible`);
    else {
      if (topBarRows.length !== 1) failures.push(`${app.id}: rendered top bars occupy multiple rows: ${topBarRows.join(', ')}`);
      const topBar = visibleTopBars.first();
      const identity = await topBar.locator('.nd-app-bar__identity').innerText();
      const actions = await topBar.locator('.nd-app-bar__navigation').innerText();
      const githubHref = await topBar.locator('a[title="View this app on GitHub"]').getAttribute('href');
      if (!identity.includes(app.title)) failures.push(`${app.id}: top bar is missing the app name`);
      if (!identity.includes(app.description)) failures.push(`${app.id}: top bar is missing the short explanation`);
      if (!/v\d+\.\d+/.test(identity)) failures.push(`${app.id}: top bar is missing a version`);
      if (actions.replace(/\s+/g, ' ').trim() !== 'About Cite Privacy Light More Apps GitHub') {
        failures.push(`${app.id}: top-bar actions are out of contract: ${actions.replace(/\s+/g, ' ').trim()}`);
      }
      if (githubHref !== `https://github.com/neurodesk/webapps/tree/main/apps/${app.id}`) {
        failures.push(`${app.id}: top-bar GitHub link is ${githubHref ?? 'missing'}`);
      }
    }
    if (themeState.appId !== app.id) failures.push(`${app.id}: document theme identity is ${themeState.appId ?? 'missing'}`);
    if (themeState.theme !== 'dark') failures.push(`${app.id}: document dark-theme identity is ${themeState.theme ?? 'missing'}`);
    if (themeState.colorScheme !== 'dark') failures.push(`${app.id}: browser color scheme is ${themeState.colorScheme || 'missing'}`);
    if (themeState.brandPrimary !== '#91c84a') failures.push(`${app.id}: Neurocontainers dark-theme tokens were not applied`);
    if (!['rgb(16, 20, 13)', 'rgb(10, 12, 8)'].includes(themeState.pageBackground)) {
      failures.push(`${app.id}: page background is outside the dark palette: ${themeState.pageBackground}`);
    }
    if (darkStartPage && !['rgb(22, 26, 14)', 'rgb(16, 20, 13)', 'rgb(10, 12, 8)'].includes(darkStartPage)) {
      failures.push(`${app.id}: start page background is outside the dark palette: ${darkStartPage}`);
    }
    for (const { selector, foreground, background, ratio } of darkStartPageContrast) {
      if (ratio < 4.5) {
        failures.push(`${app.id}: ${selector} dark-theme contrast is ${ratio.toFixed(2)}:1 (${foreground} on ${background})`);
      }
    }

    const overflowingControls = await page.evaluate(() => [...document.querySelectorAll('.nd-imaging-controls')]
      .filter((controls) => controls.scrollWidth > controls.clientWidth + 1)
      .map((controls) => ({ clientWidth: controls.clientWidth, scrollWidth: controls.scrollWidth })));
    if (overflowingControls.length) {
      failures.push(`${app.id}: imaging controls overflow horizontally: ${JSON.stringify(overflowingControls)}`);
    }

    if (app.id === 'calmar') {
      const startPage = page.locator('#startPage');
      if (!(await startPage.isVisible())) failures.push('calmar: start page is not visible before entering the app');
      else {
        await page.locator('#enterAppButton').click();
        if (await startPage.isVisible()) failures.push('calmar: Start analysis did not enter the analysis workspace');
      }
    }

    const appThemeToggle = visibleTopBars.first().locator('[data-neurodesk-theme-toggle]');
    if (await appThemeToggle.count() !== 1) {
      failures.push(`${app.id}: visible top bar does not have exactly one theme toggle`);
    } else {
      await appThemeToggle.click();
      const lightThemeState = await page.evaluate(() => ({
        theme: document.documentElement.dataset.neurodeskTheme,
        colorScheme: getComputedStyle(document.documentElement).colorScheme,
        brandPrimary: getComputedStyle(document.documentElement).getPropertyValue('--nd-brand-primary').trim(),
      }));
      if (lightThemeState.theme !== 'light' || lightThemeState.colorScheme !== 'light') {
        failures.push(`${app.id}: theme toggle did not apply the light color scheme`);
      }
      if (lightThemeState.brandPrimary !== '#3f6f24') {
        failures.push(`${app.id}: Neurodesk light-theme tokens were not applied`);
      }
      await appThemeToggle.click();
    }
    if (pageErrors.length) failures.push(`${app.id}: page errors: ${[...new Set(pageErrors)].join(' | ')}`);
    if (responseErrors.length) failures.push(`${app.id}: failed same-origin responses: ${[...new Set(responseErrors)].join(' | ')}`);
    if (subpathLeaks.length) failures.push(`${app.id}: assets escaped app subpath: ${[...new Set(subpathLeaks)].join(', ')}`);
    if (app.id === 'seedseg') {
      const consoleText = await page.locator('#consoleOutput').innerText();
      if (!consoleText.includes('Worker ready')) failures.push(`seedseg: worker did not initialize: ${consoleText.trim()}`);
    }
    if (app.id === 'musclemap' && !skipScientificWorkflows) {
      try {
        await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 30_000 });
        const result = await verifyMuscleMapThreads(page, `${origin}/${app.path}/`);
        console.log(`PASS ${app.id}: ORT session used ${result.threadCount} threads`);
        const pipeline = await verifyMuscleMapFullPipeline(page, `${origin}/${app.path}/`);
        console.log(
          `PASS ${app.id}: full v1.4 pipeline produced ${pipeline.segmentationBytes} bytes `
          + `and ${pipeline.totalVolumeMl} mL of metrics`,
        );
      } catch (error) {
        failures.push(`${app.id}: ${error.message}`);
      }
    }

    const moreApps = page.locator('[title="More Neurodesk web apps"]:visible').first();
    if (await moreApps.count() !== 1) {
      failures.push(`${app.id}: More Apps link is missing`);
    } else {
      returningHome = true;
      await Promise.all([
        page.waitForURL(`${origin}/`),
        moreApps.click(),
      ]);
      if (await page.title() !== 'Neurodesk Webapps') {
        failures.push(`${app.id}: More Apps did not render the composite start page`);
      }
    }

    console.log(`PASS /${app.path}/ — ${title}`);
    await page.close();
  }
} finally {
  await browser.close();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

if (failures.length) throw new Error(`Composite-site smoke failures:\n- ${failures.join('\n- ')}`);
console.log(`Composite-site smoke passed for ${appsUnderTest.length} webapp${appsUnderTest.length === 1 ? '' : 's'}.`);
