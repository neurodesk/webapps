// The handoff module in real browsers: IndexedDB, Blobs, sessionStorage and navigation behave
// differently in each engine, so the module runs unmodified in a page per app path. Pass engine
// names to limit the run (default: chromium firefox webkit).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, describe, test as nodeTest } from 'node:test';
import { fileURLToPath } from 'node:url';
import playwright from '@playwright/test';
import { serveSite } from '../../../test-utils/serve-site.mjs';

const engines = process.argv.slice(2).length ? process.argv.slice(2) : ['chromium', 'firefox', 'webkit'];
const SENDER = 'dicomview';
const RECEIVER = 'white-matter-lesions';
const MINUTE = 60 * 1000;
const GONE = 'The image sent from DICOM View is no longer available. Send it again.';
// A test whose page never settles fails after a minute instead of hanging the run.
const test = (name, options, fn) => (fn ? nodeTest(name, { timeout: MINUTE, ...options }, fn) : nodeTest(name, { timeout: MINUTE }, options));

const fixture = `<!doctype html>
<meta charset="utf-8">
<title>Handoff fixture</title>
<script type="module">
  import * as handoff from '/handoff/index.js';
  const settled = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  function open() {
    const request = indexedDB.open('neurodesk-handoff', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('entries', { keyPath: 'id' });
    return settled(request);
  }
  window.keys = async () => {
    const database = await open();
    try { return await settled(database.transaction('entries').objectStore('entries').getAllKeys()); }
    finally { database.close(); }
  };
  window.secrets = () => Object.keys(sessionStorage).filter((key) => key.startsWith('neurodesk-handoff:'));
  // An entry as a send would leave it; with secret, this tab holds the secret it was sent with.
  window.seed = async (entry, { secret = false } = {}) => {
    if (secret) {
      const value = crypto.randomUUID();
      sessionStorage.setItem('neurodesk-handoff:' + entry.id, value);
      const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
      entry.proof = Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }
    const database = await open();
    const transaction = database.transaction('entries', 'readwrite');
    transaction.objectStore('entries').put(entry);
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
    database.close();
  };
  window.events = [];
  const transaction = IDBDatabase.prototype.transaction;
  IDBDatabase.prototype.transaction = function (...args) {
    const opened = transaction.apply(this, args);
    opened.addEventListener('complete', () => window.events.push('complete:' + opened.mode));
    return opened;
  };
  window.stubDocument = () => ({
    baseURI: document.baseURI,
    defaultView: window,
    location: {
      assign: (url) => {
        if (window.failAssign) throw new Error('navigation refused');
        window.events.push('assign');
        window.assigned = url;
      },
    },
  });
  window.send = (names = ['scan.nii', 'scan.json'], signal) => handoff.sendHandoff({
    target: '${RECEIVER}',
    source: { app: '${SENDER}', title: 'DICOM View' },
    files: names.map((name) => new File([name + ' bytes'], name, { type: name.endsWith('.json') ? 'application/json' : 'application/octet-stream' })),
    document: stubDocument(),
    signal,
  }).then(() => window.assigned);
  // Takes the handoff, then loads its files as an app would; a failed load is the app's own.
  window.receive = (fail = false, signal) => handoff.takeHandoff({ signal }).then(async (result) => {
    if (!result) return null;
    window.keysDuringLoad = await keys();
    window.files = result.files;
    if (fail) throw new Error('load failed');
    window.loaded = await Promise.all(result.files.map(async (file) => [file.name, file.type, await file.text()]));
    return { title: result.source.title, names: result.files.map((file) => file.name) };
  });
  window.handoff = handoff;
  window.ready = true;
</script>`;

const root = await mkdtemp(join(tmpdir(), 'handoff-browser-'));
for (const app of [SENDER, RECEIVER]) {
  await mkdir(join(root, app), { recursive: true });
  await writeFile(join(root, app, 'index.html'), fixture);
}
const files = new Map([['/handoff/index.js', fileURLToPath(new URL('../src/handoff/index.js', import.meta.url))]]);
const site = await serveSite(root, { files });
after(async () => {
  await site.close();
  await rm(root, { recursive: true, force: true });
});

async function visit(page, url) {
  await page.goto(url);
  await page.waitForFunction(() => window.ready);
  return page;
}

const open = async (context, path) => visit(await context.newPage(), `${site.origin}${path}`);

// Sends with navigation stubbed, then opens the receiver in the same tab, as the real
// navigation would; returns that tab and the receiver URL.
async function sentInTab(context, hash = (value) => value) {
  const page = await open(context, `/${SENDER}/`);
  const url = new URL(await page.evaluate(() => window.send()));
  url.hash = hash(url.hash.slice(1));
  await visit(page, url.href);
  return { page, url: url.href };
}

const receiveError = (page, fail) => page.evaluate((shouldFail) => window.receive(shouldFail).then(() => null, (error) => error.message), fail);

// The engines run side by side; each engine's tests run one at a time.
describe('handoff', { concurrency: true }, () => {
  for (const engine of engines) suite(engine);
});

function suite(engine) {
  describe(engine, { concurrency: 1 }, () => {
    let browser;
    let context;
    // Closing the context also ends the evaluations of a test that timed out.
    afterEach(async () => { await context?.close(); });
    after(async () => { await browser?.close(); });

    // A fresh context in one browser, or a profile on disk where the test restarts the browser
    // and in WebKit, whose ephemeral sessions, like Safari's private windows, refuse Blobs in
    // IndexedDB (the last test covers that).
    async function fresh(profile) {
      await context?.close();
      if (profile || engine === 'webkit') {
        context = await playwright[engine].launchPersistentContext(profile ?? await mkdtemp(join(root, 'profile-')));
      } else {
        browser ??= await playwright[engine].launch();
        context = await browser.newContext();
      }
      return context;
    }

    test('the entry is committed before the page navigates, and its secret stays in the tab', async () => {
      const sender = await open(await fresh(), `/${SENDER}/`);
      const url = await sender.evaluate(() => window.send());
      const id = new URL(url).hash.replace('#handoff=', '');
      assert.equal(new URL(url).pathname, `/${RECEIVER}/`);
      const events = await sender.evaluate(() => window.events);
      assert.equal(events.at(-1), 'assign');
      assert.ok(events.indexOf('complete:readwrite') >= 0 && events.lastIndexOf('complete:readwrite') < events.indexOf('assign'), events.join(', '));
      assert.deepEqual(await sender.evaluate(() => window.keys()), [id]);
      assert.deepEqual(await sender.evaluate(() => window.secrets()), [`neurodesk-handoff:${id}`]);
    });

    test('the receiving tab takes the entry before loading, gets every file, and clears only its hash parameter', async () => {
      const { page } = await sentInTab(await fresh(), (hash) => `view=axial&${hash}&q=a%20b`);
      assert.deepEqual(await page.evaluate(() => window.receive()), { title: 'DICOM View', names: ['scan.nii', 'scan.json'] });
      assert.deepEqual(await page.evaluate(() => window.keysDuringLoad), [], 'deleted before load ran');
      assert.deepEqual(await page.evaluate(() => window.secrets()), [], 'the secret is used up');
      assert.deepEqual(await page.evaluate(() => window.loaded), [
        ['scan.nii', 'application/octet-stream', 'scan.nii bytes'],
        ['scan.json', 'application/json', 'scan.json bytes'],
      ]);
      assert.equal(await page.evaluate(() => location.hash), '#view=axial&q=a%20b');
      assert.equal(await page.evaluate(() => window.files[0].text()), 'scan.nii bytes', 'the files outlive their entry');
      assert.equal(await page.evaluate(() => window.receive()), null, 'nothing left to receive');
    });

    test('a taken image of several megabytes stays readable in a new worker after its entry is gone', async () => {
      const sender = await open(await fresh(), `/${SENDER}/`);
      const size = 8 * 1024 * 1024;
      const url = await sender.evaluate((size) => {
        const bytes = new Uint8Array(size);
        for (let index = 0; index < size; index++) bytes[index] = (index * 31) % 251;
        return window.handoff.sendHandoff({
          target: 'white-matter-lesions', source: { app: 'dicomview', title: 'DICOM View' },
          files: [new File([bytes], 'large.nii')], document: window.stubDocument(),
        }).then(() => window.assigned);
      }, size);
      // The receiving page must not share the sender's in-memory Blob, which would keep WebKit's
      // bytes alive: after garbage collection or a process swap only the stored copy remains.
      const secrets = await sender.evaluate(() => Object.fromEntries(window.secrets().map((key) => [key, sessionStorage.getItem(key)])));
      await sender.close();
      const page = await open(context, `/${RECEIVER}/`);
      await page.evaluate((copied) => { for (const [key, value] of Object.entries(copied)) sessionStorage.setItem(key, value); }, secrets);
      await visit(page, url);
      const read = await page.evaluate(async () => {
        const { files: [file] } = await window.handoff.takeHandoff();
        const keys = await window.keys();
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        // As the segmentation worker does: a fresh worker reads the File it is given.
        const source = `onmessage = async ({ data }) => {
          try {
            const bytes = new Uint8Array(await data.arrayBuffer());
            let sum = 0;
            for (let i = 0; i < bytes.length; i++) sum = (sum + bytes[i] * (i % 7 + 1)) % 1000000007;
            postMessage({ length: bytes.length, sum });
          } catch (error) {
            postMessage({ error: error.message });
          }
        };`;
        const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
        const result = await new Promise((resolve) => {
          worker.onmessage = ({ data }) => resolve(data);
          worker.onerror = (event) => resolve({ error: event.message || 'worker error' });
          worker.postMessage(file);
        });
        worker.terminate();
        return { keys, ...result };
      });
      let sum = 0;
      for (let index = 0; index < size; index++) sum = (sum + ((index * 31) % 251) * (index % 7 + 1)) % 1000000007;
      assert.deepEqual(read, { keys: [], length: size, sum });
    });

    test('a failed load leaves nothing behind and is not retried', async () => {
      const { page, url } = await sentInTab(await fresh());
      assert.equal(await receiveError(page, true), 'load failed');
      assert.deepEqual(await page.evaluate(() => window.keys()), []);
      assert.equal(await page.evaluate(() => location.hash), '');
      await visit(page, url);
      assert.equal(await receiveError(page), 'The image sent from another app is no longer available. Send it again.');
    });

    // A load cancelled while the files are copied out rejects with AbortError, stops the copy, and
    // leaves nothing behind. Each engine's copy path is held at its first read until released.
    async function cancelledDuringCopy(page, hold) {
      const outcome = await page.evaluate(async (hold) => {
        window.held = Promise.withResolvers();
        window.reached = Promise.withResolvers();
        (0, eval)(hold);
        const controller = new AbortController();
        const receiving = window.receive(false, controller.signal).then(() => 'received', (error) => error.name);
        await window.reached.promise;
        controller.abort();
        window.held.resolve();
        return receiving;
      }, hold);
      assert.equal(outcome, 'AbortError');
      assert.equal(await page.evaluate(() => window.files), undefined, 'no files were handed out');
      assert.deepEqual(await page.evaluate(() => window.keys()), []);
      assert.deepEqual(await page.evaluate(() => window.secrets()), []);
      assert.equal(await page.evaluate(() => location.hash), '');
    }

    test('a load cancelled during the streamed copy cancels the source stream and releases it', { skip: engine === 'webkit' }, async () => {
      const { page } = await sentInTab(await fresh());
      // Each stored Blob's stream is wrapped to record its cancellation; its first chunk is held.
      await cancelledDuringCopy(page, `
        window.sources = [];
        const original = Blob.prototype.stream;
        Blob.prototype.stream = function () {
          const reader = original.call(this).getReader();
          const source = new ReadableStream({
            pull: (controller) => reader.read().then(({ done, value }) => (done ? controller.close() : controller.enqueue(value))),
            cancel: (reason) => { source.cancelledWith = reason?.name ?? String(reason); return reader.cancel(reason); },
          });
          window.sources.push(source);
          return source.pipeThrough(new TransformStream({
            transform: (chunk, controller) => { window.reached.resolve(); return window.held.promise.then(() => controller.enqueue(chunk)); },
          }));
        };
      `);
      const sources = await page.evaluate(() => window.sources.map((source) => ({ cancelledWith: source.cancelledWith, locked: source.locked })));
      assert.deepEqual(sources, [{ cancelledWith: 'AbortError', locked: false }, { cancelledWith: 'AbortError', locked: false }]);
    });

    test('a load cancelled during the first piece of a pieced copy reads no second piece', { skip: engine !== 'webkit' }, async () => {
      const { page } = await sentInTab(await fresh());
      // Every Blob reports two pieces' worth of size, so each file is copied in two slices; every
      // piece read is held until released, and the slices are recorded.
      await cancelledDuringCopy(page, `
        window.slices = [];
        Object.defineProperty(Blob.prototype, 'size', { get: () => 2 * 64 * 1024 * 1024 });
        const slice = Blob.prototype.slice;
        Blob.prototype.slice = function (start, end) { window.slices.push(start); return slice.call(this, start, end); };
        const read = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = function () { window.reached.resolve(); return window.held.promise.then(() => read.call(this)); };
      `);
      assert.deepEqual(await page.evaluate(() => window.slices), [0, 0], 'one piece per file was read before the abort, none after');
    });

    test('the engine detection matches the user agent this engine reports', async () => {
      const page = await open(await fresh(), `/${RECEIVER}/`);
      assert.equal(await page.evaluate(() => window.handoff.copiesInPieces(navigator.userAgent)), engine === 'webkit');
    });

    test('of a tab and its duplicate, which share the secret, exactly one gets the files', async () => {
      const { page, url } = await sentInTab(await fresh());
      const secrets = await page.evaluate(() => Object.fromEntries(window.secrets().map((key) => [key, sessionStorage.getItem(key)])));
      const duplicate = await open(context, `/${RECEIVER}/`);
      await duplicate.evaluate((copied) => { for (const [key, value] of Object.entries(copied)) sessionStorage.setItem(key, value); }, secrets);
      await visit(duplicate, url);
      const tabs = [page, duplicate];
      // Both receive at the same moment, released together by one broadcast.
      await Promise.all(tabs.map((tab) => tab.evaluate(() => {
        const channel = new BroadcastChannel('go');
        window.outcome = new Promise((resolve) => {
          channel.onmessage = () => window.receive().then((result) => resolve(result.names.join()), (error) => resolve(error.message));
        });
      })));
      await (await open(context, `/${SENDER}/`)).evaluate(() => new BroadcastChannel('go').postMessage('go'));
      const [refused, received] = (await Promise.all(tabs.map((tab) => tab.evaluate(() => window.outcome)))).sort();
      assert.equal(received, 'scan.nii,scan.json');
      assert.match(refused, /^The image sent from (DICOM View|another app) is no longer available\. Send it again\.$/);
      assert.deepEqual(await page.evaluate(() => window.keys()), []);
    });

    test('another tab without the secret cannot take the image, and deletes it', async () => {
      const { page, url } = await sentInTab(await fresh());
      const other = await visit(await context.newPage(), url);
      assert.equal(await receiveError(other), GONE);
      assert.deepEqual(await other.evaluate(() => window.keys()), []);
      assert.equal(await receiveError(page), 'The image sent from another app is no longer available. Send it again.');
    });

    test('after the browser restarts, an unreceived image cannot be received and is deleted', async () => {
      const profile = await mkdtemp(join(root, 'profile-'));
      const sender = await open(await fresh(profile), `/${SENDER}/`);
      const url = await sender.evaluate(() => window.send());
      await fresh(profile);
      const page = await visit(await context.newPage(), url);
      assert.deepEqual((await page.evaluate(() => window.keys())).length, 1, 'the entry is still on disk');
      assert.equal(await receiveError(page), GONE);
      assert.deepEqual(await page.evaluate(() => window.keys()), []);
    });

    test('an expired entry is refused with its sender named, and deleted', async () => {
      const receiver = await open(await fresh(), `/${RECEIVER}/`);
      await receiver.evaluate((age) => window.seed({
        id: 'old', createdAt: Date.now() - age, target: 'white-matter-lesions',
        source: { app: 'dicomview', title: 'DICOM View' }, files: [{ name: 'scan.nii', type: '', blob: new Blob(['x']) }],
      }, { secret: true }), 2 * MINUTE + 1000);
      await receiver.evaluate(() => { location.hash = 'handoff=old'; });
      assert.equal(await receiveError(receiver), GONE);
      assert.equal(await receiver.evaluate(() => window.loaded), undefined);
      assert.deepEqual(await receiver.evaluate(() => window.keys()), []);
    });

    test('a sweep that began before a send keeps the fresh entry', async () => {
      const sender = await open(await fresh(), `/${SENDER}/`);
      await sender.evaluate(() => window.seed({ id: 'stale', createdAt: 1, target: 'x', source: {}, files: [] }));
      const keys = await sender.evaluate(async () => {
        let clock = Date.now();
        Date.now = () => ++clock;
        // The sweep stalls before opening the database until the send has committed.
        const listed = indexedDB.databases.bind(indexedDB);
        const held = Promise.withResolvers();
        let first = true;
        indexedDB.databases = () => (first ? ((first = false), held.promise.then(listed)) : listed());
        const sweeping = window.handoff.sweepHandoffs();
        const url = await window.send();
        held.resolve();
        await sweeping;
        return { sent: new URL(url).hash.replace('#handoff=', ''), kept: await window.keys() };
      });
      assert.deepEqual(keys.kept, [keys.sent]);
    });

    test('a send whose navigation fails removes the entry and its secret', async () => {
      const sender = await open(await fresh(), `/${SENDER}/`);
      const message = await sender.evaluate(() => { window.failAssign = true; return window.send().then(() => null, (error) => error.message); });
      assert.equal(message, 'This browser cannot pass the image on. Download the image instead.');
      assert.deepEqual(await sender.evaluate(() => window.keys()), []);
      assert.deepEqual(await sender.evaluate(() => window.secrets()), []);
    });

    test('a send aborted while the target is checked stores nothing and stays put', async () => {
      const sender = await open(await fresh(), `/${SENDER}/`);
      const outcome = await sender.evaluate(async () => {
        const fetched = window.fetch;
        const held = Promise.withResolvers();
        window.fetch = (...args) => held.promise.then(() => fetched(...args));
        const controller = new AbortController();
        const sending = window.send(undefined, controller.signal).then(() => 'sent', (error) => error.name);
        controller.abort();
        held.resolve();
        return sending;
      });
      assert.equal(outcome, 'AbortError');
      assert.deepEqual(await sender.evaluate(() => window.keys()), []);
      assert.deepEqual(await sender.evaluate(() => window.secrets()), []);
      assert.equal(await sender.evaluate(() => window.assigned), undefined);
    });

    test('a connection that opens after the open was reported blocked is closed', async () => {
      const page = await open(await fresh(), `/${SENDER}/`);
      const outcome = await page.evaluate(async () => {
        await window.keys();
        const opening = indexedDB.open.bind(indexedDB);
        let late;
        indexedDB.open = (...args) => {
          const real = opening(...args);
          const reported = { get result() { return real.result; }, get error() { return real.error; } };
          real.onupgradeneeded = (event) => reported.onupgradeneeded?.(event);
          real.onerror = (event) => reported.onerror?.(event);
          real.onsuccess = (event) => {
            late = real.result;
            reported.onblocked?.(event);
            reported.onsuccess?.(event);
          };
          return reported;
        };
        const message = await window.handoff.sweepHandoffs().then(() => null, (error) => error.message);
        let state = 'open';
        try { late.transaction('entries'); } catch (error) { state = error.name; }
        return { message, state };
      });
      assert.match(outcome.message, /older handoff store open/);
      assert.equal(outcome.state, 'InvalidStateError', 'the late connection was closed');
    });

    // An unisolated page whose isolation bootstrap is stubbed by init.
    async function unisolatedPage(server, init, { clock = false, entry = true } = {}) {
      const page = await (await fresh()).newPage();
      if (clock) await page.clock.install();
      await page.addInitScript(init);
      await visit(page, `${server.origin}/${RECEIVER}/`);
      if (!entry) return page;
      await page.evaluate(() => window.seed({ id: 'held', createdAt: Date.now(), target: 'white-matter-lesions', source: { title: 'DICOM View' }, files: [] }, { secret: true }));
      await page.evaluate(() => { location.hash = 'handoff=held'; });
      return page;
    }

    test('a page the isolation service worker is about to reload leaves the entry and secret for the next one', async () => {
      const unisolated = await serveSite(root, { files, isolationHeaders: false });
      try {
        const page = await unisolatedPage(unisolated, () => {
          window.coiWillReload = Promise.resolve(true);
          window.coiHoldReloads = () => { window.held = true; };
        });
        assert.equal(await page.evaluate(() => window.receive()), null);
        assert.deepEqual(await page.evaluate(() => window.keys()), ['held']);
        assert.deepEqual(await page.evaluate(() => window.secrets()), ['neurodesk-handoff:held']);
        assert.equal(await page.evaluate(() => location.hash), '#handoff=held');
        assert.equal(await page.evaluate(() => window.held), undefined, 'the reload is not held off');
        await page.evaluate(() => { window.coiWillReload = Promise.resolve(false); });
        assert.deepEqual(await page.evaluate(() => window.receive()), { title: 'DICOM View', names: [] });
        assert.equal(await page.evaluate(() => window.held), true, 'reloads are held before the claim');
      } finally {
        await unisolated.close();
      }
    });

    test('a receiver whose isolation worker never decides claims after ten seconds and holds reloads', async () => {
      const unisolated = await serveSite(root, { files, isolationHeaders: false });
      try {
        const page = await unisolatedPage(unisolated, () => {
          window.coiWillReload = new Promise(() => {});
          window.coiHoldReloads = () => { window.held = true; };
        }, { clock: true });
        await page.evaluate(() => { window.outcome = window.receive(); });
        await page.clock.runFor(9_000);
        assert.deepEqual(await page.evaluate(() => window.keys()), ['held'], 'still waiting at nine seconds');
        await page.clock.runFor(1_000);
        assert.deepEqual(await page.evaluate(() => window.outcome), { title: 'DICOM View', names: [] });
        assert.equal(await page.evaluate(() => window.held), true);
      } finally {
        await unisolated.close();
      }
    });

    test('a page without a handoff neither waits for the isolation worker nor holds its reloads', async () => {
      const unisolated = await serveSite(root, { files, isolationHeaders: false });
      try {
        const page = await unisolatedPage(unisolated, () => {
          window.coiWillReload = new Promise(() => {});
          window.coiHoldReloads = () => { window.held = true; };
        }, { entry: false });
        const outcome = await page.evaluate(() => Promise.race([window.receive(), new Promise((resolve) => { setTimeout(resolve, 1000, 'waited'); })]));
        assert.equal(outcome, null);
        assert.equal(await page.evaluate(() => window.held), undefined);
      } finally {
        await unisolated.close();
      }
    });

    test('a send to an app that is not served stores nothing', async () => {
      const sender = await open(await fresh(), `/${SENDER}/`);
      const message = await sender.evaluate(() => window.handoff.sendHandoff({
        target: 'missing-app', source: { app: 'dicomview', title: 'DICOM View' }, files: [new File(['x'], 'scan.nii')], document: window.stubDocument(),
      }).then(() => null, (error) => error.message));
      assert.equal(message, '/missing-app/ is not served beside this app. Download the image instead.');
      assert.deepEqual(await sender.evaluate(() => window.keys()), []);
      assert.equal(await sender.evaluate(() => window.assigned), undefined);
    });

    // An in-memory profile, as a private window or the desktop app's session has.
    test('a private window hands the image over, or, in WebKit, says it cannot and stays put', async () => {
      browser ??= await playwright[engine].launch();
      context = await browser.newContext();
      const sender = await open(context, `/${SENDER}/`);
      const outcome = await sender.evaluate(() => window.send().then((url) => url, (error) => error.message));
      if (engine === 'webkit') {
        assert.equal(outcome, 'This browser cannot pass the image on. Download the image instead.');
        assert.equal(await sender.evaluate(() => window.assigned), undefined);
        assert.deepEqual(await sender.evaluate(() => window.secrets()), []);
      } else {
        await visit(sender, outcome);
        assert.deepEqual(await sender.evaluate(() => window.receive()), { title: 'DICOM View', names: ['scan.nii', 'scan.json'] });
        assert.deepEqual(await sender.evaluate(() => window.keys()), []);
      }
    });
  });
}
