// The interface audit's count of requests that left for other hosts, in Chromium
// with a service worker between the page and the network:
//   node test/external-requests.smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from '@playwright/test';
import { trackExternalRequests } from '../scripts/lib/external-requests.mjs';
import { serveSite } from '../test-utils/serve-site.mjs';

const host = 'https://examples.invalid';
// The worker fetches what the page asks of another host, then never answers the page,
// so the page's copy of the request is still open when the page cancels it.
const worker = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin === self.location.origin) return;
  const fetched = url.pathname === '/never-fetched' ? Promise.resolve() : fetch(url.href);
  event.respondWith(fetched.then(() => new Promise(() => {})));
});
`;
const document = `<!doctype html>
<script>
  window.controlled = navigator.serviceWorker.register('worker.js').then(() => navigator.serviceWorker.ready)
    .then(() => navigator.serviceWorker.controller || new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve)));
  window.request = url => {
    const cancel = new AbortController();
    window.cancel = () => cancel.abort();
    window.outcome = fetch(url, { signal: cancel.signal }).then(() => 'answered', error => error.name);
  };
</script>`;

async function controlledPage(t) {
  const directory = await mkdtemp(join(tmpdir(), 'external-requests-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'index.html'), document);
  await writeFile(join(directory, 'worker.js'), worker);
  const site = await serveSite(directory);
  t.after(site.close);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext();
  const network = trackExternalRequests(context, site.origin);
  const fulfil = route => route.fulfill({ body: 'example', headers: { 'access-control-allow-origin': '*' } });
  await context.route(`${host}/cached`, route => {
    network.answered(route.request());
    return fulfil(route);
  });
  // Stands in for the hosted file: the run does not claim to have answered it.
  await context.route(`${host}/hosted`, fulfil);
  const page = await context.newPage();
  await page.goto(`${site.origin}/`);
  await page.evaluate(() => window.controlled);
  // Requests `path`, waits until the worker has dealt with it, then cancels the page's copy.
  const requestThenCancel = async path => {
    const url = `${host}${path}`;
    const workerFetch = path === '/never-fetched' ? null : context.waitForEvent('requestfinished', request => Boolean(request.serviceWorker()) && request.url() === url);
    const cancelled = context.waitForEvent('requestfailed', request => !request.serviceWorker() && request.url() === url);
    await page.evaluate(target => window.request(target), url);
    await workerFetch;
    await page.evaluate(() => window.cancel());
    assert.equal(await page.evaluate(() => window.outcome), 'AbortError');
    await cancelled;
  };
  return { network, requestThenCancel };
}

const paths = urls => urls.map(url => url.pathname);

test('a page request cancelled after its worker fetch was answered here is not a network request', async t => {
  const { network, requestThenCancel } = await controlledPage(t);
  await requestThenCancel('/cached');
  assert.deepEqual(paths(network.sent()), []);
});

test('a worker fetch that went to the network counts once, without its cancelled page copy', async t => {
  const { network, requestThenCancel } = await controlledPage(t);
  await requestThenCancel('/hosted');
  assert.deepEqual(paths(network.sent()), ['/hosted']);
  await requestThenCancel('/cached');
  assert.deepEqual(paths(network.sent()), ['/hosted']);
});

test('a cancelled page request no worker fetch accounts for still counts', async t => {
  const { network, requestThenCancel } = await controlledPage(t);
  await requestThenCancel('/never-fetched');
  assert.deepEqual(paths(network.sent()), ['/never-fetched']);
});
