import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import { parseNorms } from '@neurodesk/synthseg/brainquant';
import { parseVolumesCsv, VOLUME_COLUMNS } from '@neurodesk/synthseg/results';
import { legendEntries, rawVolumeRows, volumeReport } from '../src/volume-report.js';

const fixtures = new URL('../../../packages/synthseg/test/fixtures/', import.meta.url);
const norms = parseNorms(JSON.parse(await readFile(new URL('brainquant_norms.json', fixtures), 'utf8')));
const { volumes } = parseVolumesCsv(await readFile(new URL('T1_head_fast_vol.csv', fixtures), 'utf8'));
const source = await readFile(new URL('../src/main.js', import.meta.url), 'utf8');

// Execute the production DOM renderer without booting NiiVue or WebGPU. The browser
// suite separately covers the real controls, inference completion and downloads.
function setup() {
  const dom = new JSDOM('<div id="volumeReport"></div>');
  const panel = dom.window.document.getElementById('volumeReport');
  const context = vm.createContext({
    document: dom.window.document,
    DOMParser: dom.window.DOMParser,
    $: () => panel,
    volumes,
    volumesVoxelSizeMm: 1,
    reference: () => ({ id: 'ixi-fast', cohort: 'ixi', reason: 'test' }),
    subject: () => ({ age: 45, sex: 'female' }),
    loadNorms: async () => norms,
    volumeReport,
    rawVolumeRows,
    legendEntries,
  });
  vm.runInContext(source.slice(source.indexOf('function element('), source.indexOf('function subjectChanged()')), context);
  return { context, panel };
}

test('the panel explains failed assessment and missing norms while retaining raw rows, then recovers', async () => {
  const { context, panel } = setup();
  context.volumes = { ...volumes, 'left hippocampus': 0 };
  await context.renderVolumes();
  assert.match(panel.querySelector('.nd-message.error').textContent, /no volume for Left hippocampus/);
  assert.equal(panel.querySelectorAll('tbody tr').length, VOLUME_COLUMNS.length);
  assert.equal(panel.querySelectorAll('th').length, 2);
  assert.equal(panel.querySelectorAll('figure').length, 0);
  assert.equal(panel.querySelectorAll('tbody tr')[VOLUME_COLUMNS.indexOf('left hippocampus')].cells[1].textContent, '0.00');
  context.loadNorms = async () => { throw new Error('Reference unavailable'); };
  await context.renderVolumes();
  assert.match(panel.textContent, /Reference unavailable/);
  assert.equal(panel.querySelectorAll('tbody tr').length, VOLUME_COLUMNS.length);
  context.volumes = volumes;
  context.loadNorms = async () => norms;
  await context.renderVolumes();
  assert.equal(panel.querySelectorAll('figure').length, 10);
  assert.equal(panel.querySelectorAll('.nd-message.error').length, 0);
});

test('late reference failures do not replace a newer report or repopulate cleared output', async () => {
  const { context, panel } = setup();
  let rejectOld;
  context.loadNorms = () => new Promise((_, reject) => { rejectOld = reject; });
  const old = context.renderVolumes();
  context.loadNorms = async () => norms;
  await context.renderVolumes();
  rejectOld(new Error('stale failure'));
  await old;
  assert.equal(panel.querySelectorAll('figure').length, 10);
  assert.equal(panel.querySelectorAll('.nd-message.error').length, 0);

  context.loadNorms = () => new Promise((_, reject) => { rejectOld = reject; });
  const cleared = context.renderVolumes();
  context.volumes = null;
  panel.replaceChildren();
  rejectOld(new Error('cleared failure'));
  await cleared;
  assert.equal(panel.children.length, 0);
});
