import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { arrayBufferToFile, downloadArrayBuffer, downloadBlob, downloadFile } from '../src/file-io/index.js';

// A page as the download helper sees it: a document, blob URLs and a clock.
function browser(t) {
  const { window } = new JSDOM('<main id="app"></main>');
  const clicks = [];
  const created = [];
  const revoked = [];
  window.document.addEventListener('click', event => {
    event.preventDefault();
    clicks.push({ href: event.target.href, download: event.target.download, attached: event.target.isConnected });
  });
  const original = {
    document: globalThis.document,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  };
  globalThis.document = window.document;
  URL.createObjectURL = blob => {
    created.push(blob);
    return `blob:nd/${created.length}`;
  };
  URL.revokeObjectURL = url => revoked.push(url);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => {
    globalThis.document = original.document;
    URL.createObjectURL = original.createObjectURL;
    URL.revokeObjectURL = original.revokeObjectURL;
    window.close();
  });
  return { window, clicks, created, revoked };
}

test('a download clicks a named link to the blob and leaves the page as it was', async t => {
  const page = browser(t);
  downloadArrayBuffer(new Uint8Array([1, 2, 3]).buffer, 'mask.nii.gz', 'application/gzip');

  assert.deepEqual(page.clicks, [{ href: 'blob:nd/1', download: 'mask.nii.gz', attached: true }]);
  assert.equal(page.created[0].type, 'application/gzip');
  assert.deepEqual(Array.from(new Uint8Array(await page.created[0].arrayBuffer())), [1, 2, 3]);
  assert.equal(page.window.document.body.innerHTML, '<main id="app"></main>');
});

test('the blob URL outlives the click and is released afterwards', t => {
  const page = browser(t);
  downloadBlob(new Blob(['a']), 'a.txt');
  // Safari drops a download whose URL is revoked in the same task as the click.
  assert.deepEqual(page.revoked, []);
  t.mock.timers.tick(999);
  assert.deepEqual(page.revoked, []);
  t.mock.timers.tick(1);
  assert.deepEqual(page.revoked, ['blob:nd/1']);
});

test('back-to-back downloads each get their own link, name and URL', t => {
  const page = browser(t);
  downloadFile(arrayBufferToFile(new Uint8Array([9]).buffer, 'surface.stl', 'model/stl'));
  downloadBlob(new Blob(['b']), 'report.csv');
  assert.deepEqual(page.clicks.map(click => [click.href, click.download]), [
    ['blob:nd/1', 'surface.stl'],
    ['blob:nd/2', 'report.csv'],
  ]);
  assert.equal(page.created[0].type, 'model/stl');
  t.mock.timers.tick(1000);
  assert.deepEqual(page.revoked, ['blob:nd/1', 'blob:nd/2']);
});
