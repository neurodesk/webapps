import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadAppInformation, appInformationPayload } from '../scripts/lib/app-information.mjs';
import { upstreamCitationSnapshot } from '../scripts/lib/upstream-citations.mjs';
import { mountAppShell } from '../test-utils/mount-app-shell.mjs';

const registry = await loadAppsRegistry();
const information = await loadAppInformation(registry);
const app = registry.apps.find(app => app.id === 'qsmbly');
const snapshot = JSON.parse(await readFile(new URL('../apps/qsmbly/upstream-citations.json', import.meta.url)));

test('QSMbly covers every DOI from the pinned upstream citation block without network access', () => {
  assert.equal(snapshot.commit, app.source.split('@')[1], 'upstream sync must refresh citation coverage with the source pin');
  assert.ok(snapshot.dois.length > 0);
  const cited = new Set(information.apps.qsmbly.citations.map(item => item.doi?.toLowerCase()));
  for (const doi of snapshot.dois) assert.ok(cited.has(doi), `Move upstream DOI ${doi} into registry/app-information.yml`);
});

test('citation extraction isolates the modal, normalizes links and rejects missing upstream markup', () => {
  const html = '<a href="https://doi.org/10.1/outside">Other</a><div id="citationsModal"><a href="https://doi.org/10.1/Paper">Paper</a><a href="http://dx.doi.org/10.1/paper">Duplicate</a></div>';
  assert.deepEqual(upstreamCitationSnapshot(html, 'commit', '#citationsModal'), { commit: 'commit', dois: ['10.1/paper'] });
  assert.throws(() => upstreamCitationSnapshot('', 'commit', '#citationsModal'), /block missing/);
  assert.throws(() => upstreamCitationSnapshot('<div id="citationsModal"></div>', 'commit', '#citationsModal'), /no DOI links/);
});

test('QSMbly Cite uses its registry dialog and has no app-owned citation markup or handler', async () => {
  const html = await readFile(new URL('../apps/qsmbly/index.html', import.meta.url), 'utf8');
  const js = await readFile(new URL('../apps/qsmbly/js/qsm-app-romeo.js', import.meta.url), 'utf8');
  assert.doesNotMatch(html, /citationsModal|openCitations|citation-item|data-neurodesk-control="cite"/);
  assert.doesNotMatch(js, /citationsModal|openCitations|closeCitations/);
  const window = await mountAppShell({ appId: 'qsmbly', information: appInformationPayload(information, 'qsmbly'), bodyHtml: html });
  window.document.querySelector('[data-neurodesk-shell-control="cite"]').click();
  const dialog = window.document.querySelector('.nd-app-dialog[data-dialog="cite"]');
  assert.ok(dialog.hasAttribute('open'));
  for (const item of information.apps.qsmbly.citations) {
    assert.ok(dialog.textContent.includes(item.title), `Cite displays ${item.title}`);
    if (item.doi) assert.ok(dialog.querySelector(`a[href="https://doi.org/${item.doi}"]`));
  }
  assert.match(dialog.textContent, /Renton/);
  dialog.querySelector('.nd-app-dialog__close').click();
  assert.ok(!dialog.hasAttribute('open'));
});
