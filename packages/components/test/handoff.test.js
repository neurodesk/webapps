import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { HANDOFF_TTL_MS, appPath, copiesInPieces, handoffId, handoffTargets, isExpired, withoutHandoff } from '../src/handoff/index.js';

test('the handoff id is read from the hash, alone or beside other parameters', () => {
  assert.equal(handoffId('#handoff=4f1c'), '4f1c');
  assert.equal(handoffId('handoff=4f1c'), '4f1c');
  assert.equal(handoffId('#view=axial&handoff=4f1c'), '4f1c');
  assert.equal(handoffId(''), null);
  assert.equal(handoffId('#handoff='), null);
  assert.equal(handoffId('#example=t1'), null);
});

test('removing the handoff keeps every other fragment parameter as written', () => {
  assert.equal(withoutHandoff('#handoff=4f1c'), '');
  assert.equal(withoutHandoff('#view=axial&handoff=4f1c&q=a%20b'), '#view=axial&q=a%20b');
  assert.equal(withoutHandoff('#handoff&view=axial'), '#view=axial');
  assert.equal(withoutHandoff(''), '');
});

test('an entry expires two minutes after it was sent, or when the clock runs behind it', () => {
  const createdAt = 1_000_000;
  assert.equal(HANDOFF_TTL_MS, 120_000);
  assert.equal(isExpired({ createdAt }, createdAt), false);
  assert.equal(isExpired({ createdAt }, createdAt + HANDOFF_TTL_MS - 1), false);
  assert.equal(isExpired({ createdAt }, createdAt + HANDOFF_TTL_MS), true);
  assert.equal(isExpired({ createdAt }, createdAt - 1), true);
  assert.equal(isExpired({}, createdAt), true, 'an entry without a time is never kept');
});

test('the app path is the base directory a sender names as its target', () => {
  assert.equal(appPath('https://webapps.neurodesk.org/white-matter-lesions/'), 'white-matter-lesions');
  assert.equal(appPath('https://webapps.neurodesk.org/white-matter-lesions/index.html#handoff=1'), 'white-matter-lesions');
  assert.equal(appPath('http://127.0.0.1:4000/preview/site/dicomview/?x=1'), 'dicomview');
  assert.equal(appPath('http://127.0.0.1:4000/'), '');
});

// Playwright's engines on 2026-10-19 (Chromium 156, Firefox 157, WebKit 605.1.15 / Safari 27.2),
// and a WebKit under another browser's name. A wrong guess costs memory, never the image.
test('only a WebKit engine copies the files out in pieces, whatever browser carries it', () => {
  assert.equal(copiesInPieces('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.2 Safari/605.1.15'), true);
  assert.equal(copiesInPieces('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0.7339.73 Mobile/15E148 Safari/604.1'), true);
  assert.equal(copiesInPieces('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/156.0.8078.4 Safari/537.36'), false);
  assert.equal(copiesInPieces('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36'), false);
  assert.equal(copiesInPieces('Mozilla/5.0 (X11; Linux x86_64; rv:157.0) Gecko/20100101 Firefox/157.0'), false);
  assert.equal(copiesInPieces(''), false);
});

test('the apps a page can open, from the shell\'s catalog, in title order and without its own', () => {
  const catalog = [
    { id: 'zeta', path: 'zeta', title: 'Zeta', receives: 'nifti' },
    { id: 'dicomview', path: 'dicomview', title: 'DICOM View', receives: 'nifti' },
    { id: 'spinalcordtoolbox', path: 'sct', title: 'Spinal Cord Toolbox', receives: 'nifti' },
    { id: 'dicompare', path: 'dicompare', title: 'dicompare', receives: 'dicom' },
  ];
  const page = (information) => new JSDOM(`<script type="application/json" data-neurodesk-app-information>${information}</script>`, { url: 'https://webapps.neurodesk.org/dicomview/' }).window.document;
  assert.deepEqual(handoffTargets(page(JSON.stringify({ catalog }))).map(({ path }) => path), ['dicompare', 'sct', 'zeta']);
  assert.deepEqual(handoffTargets(page('{}')), [], 'a page without a catalog offers nothing');
  assert.deepEqual(handoffTargets(page('not json')), []);
});
