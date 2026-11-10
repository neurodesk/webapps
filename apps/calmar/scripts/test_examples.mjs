import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../web/js/lnm-app.js', import.meta.url), 'utf8');
const body = source.split('  async setupExamples() {')[1].split('\n  bindEvents() {')[0];
const setup = new Function('createExampleSelector', 'fetch', 'document', `return async function() {${body}`) ;
const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));

async function loadAdapter() {
  let options;
  const loaded = [];
  const contexts = [];
  const app = {
    updateOutput() {},
    clearDiffusionInputs() {},
    clearResults() {},
    async setDeepIslesInput(kind, file) { loaded.push({ kind, file }); },
    patientBehavior: { loadExampleContext(context) { contexts.push(context); } },
    async setStructural(file) { loaded.push(file); },
    async startUploadedLesionMaskReview() {
      assert.fail('The example must compute its lesion mask');
    },
  };
  const selector = {};
  const scope = {};
  const input = { closest: () => ({ prepend(element) { assert.equal(element, selector); } }), classList: { remove() {} } };
  const document = { baseURI: 'https://example.org/calmar/', getElementById: () => input, querySelector: selector => { assert.equal(selector, '.app-container'); return scope; } };
  await setup(value => { options = value; assert.equal(value.scope, scope); return selector; },
    async () => ({ ok: true, json: async () => examples }), document).call(app);
  return { app, options, loaded, contexts };
}

test('selecting the example imports its complete scientific inputs without running processing', async () => {
  const { options, loaded, contexts } = await loadAdapter();
  assert.deepEqual(examples[0].files.map(file => file.role), ['structural']);
  const files = examples[0].files.map(file => new File(['example'], file.name));
  await options.onLoad(examples[0], { fetchFiles: async () => files, assertCurrent() {} });
  assert.equal(loaded.length, 1);
  assert.deepEqual(contexts, [examples[0].patientContext]);
  assert.deepEqual(loaded.map(file => file.name), examples[0].files.map(file => file.name));
});

test('cancelled download never replaces the current inputs', async () => {
  const { options, loaded, contexts } = await loadAdapter();
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => [],
    assertCurrent() { throw new DOMException('Cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
  assert.deepEqual(loaded, []);
});

test('failed download leaves inputs untouched and can be retried', async () => {
  const { options, loaded, contexts } = await loadAdapter();
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => { throw new Error('Download failed'); }, assertCurrent() {},
  }), /Download failed/);
  assert.deepEqual(loaded, []);
  assert.deepEqual(examples[0].files.map(file => file.role), ['structural']);
  const files = examples[0].files.map(file => new File(['example'], file.name));
  await options.onLoad(examples[0], { fetchFiles: async () => files, assertCurrent() {} });
  assert.equal(loaded.length, 1);
  assert.deepEqual(contexts, [examples[0].patientContext]);
});


test('example metadata is never applied after a superseded scan import', async () => {
  const { options, contexts } = await loadAdapter();
  let checks = 0;
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => [new File(['example'], 'scan.nii')],
    assertCurrent() { if (++checks === 2) throw new DOMException('Cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
  assert.deepEqual(contexts, []);
});

for (const roles of [['dwi', 'adc'], ['dwi', 'b0'], ['structural', 'dwi', 'adc', 'b0']]) {
  test(`example loads the complete ${roles.join('+')} bundle and clears the previous subject`, async () => {
    const { app, options, loaded, contexts } = await loadAdapter();
    let cleared = false;
    app.clearResults = value => { assert.deepEqual(value, { full: true }); cleared = true; };
    const bundle = { files: roles.map(role => ({ role, name: `${role}.nii` })) };
    const files = bundle.files.map(file => new File(['example'], file.name));
    await options.onLoad(bundle, { fetchFiles: async () => files, assertCurrent() {} });
    assert.equal(cleared, true);
    assert.equal(app.structuralFromDiffusion, null);
    assert.deepEqual(loaded.map(value => value.kind || 'structural'), roles);
    assert.deepEqual(contexts, [undefined], 'unknown demographics are cleared, never inferred');
  });
}

test('an incomplete diffusion bundle is rejected before replacing the current subject', async () => {
  const { app, options } = await loadAdapter();
  app.clearResults = () => assert.fail('must preserve the previous subject');
  await assert.rejects(options.onLoad({ files: [{ role: 'b0' }] }, {
    fetchFiles: async () => [new File(['scan'], 'b0.nii')], assertCurrent() {},
  }), /DWI\/TRACE with ADC or b0/);
});

for (const id of ['stroke-dwi-adc-soop', 'stroke-dwi-adc-isles2022']) {
  test(`${id} imports the published DWI/ADC pair and replaces previous demographics with its own`, async () => {
    const { options, loaded, contexts } = await loadAdapter();
    const example = examples.find(item => item.id === id);
    assert.deepEqual(example.files.map(file => file.role), ['dwi', 'adc']);
    await options.onLoad(example, { fetchFiles: async () => example.files.map(file => new File(['scan'], file.name)), assertCurrent() {} });
    assert.deepEqual(loaded.map(item => [item.kind, item.file.name]), example.files.map(file => [file.role, file.name]));
    assert.deepEqual(contexts, [example.patientContext]);
  });
}

// Examples carry only what their dataset publishes for that case.
test('the two chronic examples are different ARC participants with their own published context', async () => {
  const { options, loaded, contexts } = await loadAdapter();
  const chronic = examples.filter(item => item.files.length === 1 && item.files[0].role === 'structural');
  assert.deepEqual(chronic.map(item => item.id), ['stroke-lesion', 'stroke-lesion-m2001']);
  assert.equal(new Set(chronic.map(item => item.label)).size, 2, 'the menu tells the two scans apart');
  for (const example of chronic) {
    await options.onLoad(example, { fetchFiles: async () => example.files.map(file => new File(['scan'], file.name)), assertCurrent() {} });
  }
  assert.deepEqual(loaded.map(file => file.name), chronic.map(item => item.files[0].name));
  assert.deepEqual(contexts, chronic.map(item => item.patientContext));
  // ds004884 v1.0.1 participants.tsv: sub-M2001  F  38  n/a  895  87.1  Anomic; ses-1076 is 1076 days post-stroke.
  const context = chronic[1].patientContext;
  assert.deepEqual([context.ageAtStroke, context.sex, context.tpo, context.tpoUnit], [38, 'female', 895, 'days']);
  assert.deepEqual(context.assessments, [{ name: 'WAB-R Aphasia Quotient', result: '87.1 (895 days post-stroke)', date: '' }]);
  assert.match(context.notes, /1076 days post-stroke \(ses-1076\).*not contemporaneous.*Anomic/);
  assert.equal(context.source.imagingTpoDays, 1076);
  assert.equal(context.source.url, chronic[0].patientContext.source.url, 'both rows come from the same pinned participants.tsv');
  assert.match(chronic[1].files[0].name, /^sub-M2001_ses-1076_/);
});

test('SOOP sub-2 carries its participants.tsv row and no time since onset', () => {
  // ds004889 v1.1.2 participants.tsv: sub-2  M  78  w  1  0  22.84  17  n/a  "2: Cardioembolism ...". sub-1 has no row.
  const example = examples.find(item => item.id === 'stroke-dwi-adc-soop');
  const context = example.patientContext;
  assert.deepEqual(example.files.map(file => file.name), ['sub-2_rec-TRACE_dwi.nii.gz', 'sub-2_rec-ADC_dwi.nii.gz']);
  assert.deepEqual([context.ageAtStroke, context.sex, context.tpo, context.tpoUnit], [78, 'male', undefined, 'days']);
  assert.deepEqual(context.assessments, [{ name: 'NIH Stroke Scale (NIHSS)', result: '17', date: '' }]);
  assert.match(context.notes, /Age is at the time of the scan/);
  assert.match(context.notes, /cardioembolism/);
  assert.match(context.notes, /TPO is left blank/);
  assert.match(context.source.url, /^https:\/\/github\.com\/OpenNeuroDatasets\/ds004889\/blob\/[a-f0-9]{40}\/participants\.tsv$/);
  assert.match(example.label, /SOOP sub-2$/);
  assert.match(example.description, /sub-2/);
});

test('ISLES case 0001 carries the age and sex of its sidecars and no time since onset', () => {
  // sub-strokecase0001_ses-0001_{dwi,adc}.json: "PatientAge": "088Y", "PatientSex": "F".
  const example = examples.find(item => item.id === 'stroke-dwi-adc-isles2022');
  const context = example.patientContext;
  assert.equal(context.ageAtStroke, 88);
  assert.equal(context.sex, 'female');
  assert.equal(context.tpo, undefined, 'ISLES 2022 publishes no per-case onset time');
  assert.equal(context.assessments, undefined);
  assert.match(context.notes, /088Y/);
  assert.match(context.notes, /TPO is left blank/);
  const sidecar = example.files.find(file => file.role === 'dwi').url.replace(/\.nii\.gz$/, '.json');
  assert.equal(context.source.url, sidecar.replace('/resolve/', '/blob/'), 'the source link is the pinned sidecar the values were read from');
  assert.equal(examples.find(item => item.id === 'stroke-dwi-adc').patientContext, undefined, 'the rotating entry takes the context of the case it loads');
});

test('the behavioural form shows the case that is loaded and empties for a case without data', async () => {
  const { JSDOM } = await import('jsdom');
  const { bindPatientBehavior } = await import('../web/js/modules/patient-behavior.js');
  const doc = new JSDOM(await readFile(new URL('../web/index.html', import.meta.url), 'utf8')).window.document;
  const behavior = bindPatientBehavior(doc);
  const value = id => doc.getElementById(id).value;
  const isles = examples.find(item => item.id === 'stroke-dwi-adc-isles2022');
  behavior.loadExampleContext(isles.patientContext);
  assert.deepEqual([value('patientAge'), value('patientSex'), value('patientTpo'), value('patientTpoUnit')], ['88', 'female', '', 'days']);
  const report = doc.getElementById('patientBehaviorReportBody');
  assert.match(report.textContent, /Age at stroke: 88 years; Sex: Female\. Example dataset context/);
  assert.doesNotMatch(report.textContent, /Time post-onset at assessment/);
  assert.match(report.textContent, /does not publish time since stroke onset/);
  assert.equal(report.querySelector('a').href, isles.patientContext.source.url);
  assert.equal(doc.getElementById('patientContextSource').hidden, false);
  behavior.loadExampleContext(examples.find(item => item.id === 'stroke-dwi-adc-soop').patientContext);
  assert.deepEqual([value('patientAge'), value('patientSex'), value('patientTpo'), value('patientTpoUnit')], ['78', 'male', '', 'days']);
  assert.match(report.textContent, /Age at stroke: 78 years; Sex: Male\. Example dataset context/);
  assert.match(report.textContent, /NIH Stroke Scale \(NIHSS\)17/);
  assert.doesNotMatch(report.textContent, /088Y|Time post-onset at assessment/, 'nothing of the previous case remains');
  behavior.loadExampleContext(examples.find(item => item.id === 'stroke-lesion-m2001').patientContext);
  assert.deepEqual([value('patientAge'), value('patientSex'), value('patientTpo'), value('patientTpoUnit')], ['38', 'female', '895', 'days']);
  assert.match(report.textContent, /Time post-onset at assessment: 895 days/);
  assert.match(report.textContent, /87\.1 \(895 days post-stroke\)/);
  behavior.loadExampleContext(undefined);
  assert.deepEqual([value('patientAge'), value('patientSex'), value('patientTpo'), value('patientTpoUnit')], ['', '', '', 'months']);
  assert.equal(doc.getElementById('patientContextSource').hidden, true);
  assert.equal(doc.getElementById('patientBehaviorReport').hidden, true);
});
