import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { SctAnalysis, parseMetricTable } from '../web/js/controllers/SctAnalysis.js';
import { SCT_IMAGE, SCT_VERSION, validateSctSpec, sctArgv } from '../web/js/app/analysis-spec.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function setup(overrides = {}) {
    const { window } = new JSDOM('<body><div id="before"></div></body>', { url: 'https://example.test/sct/' });
    globalThis.window = window;
    globalThis.document = window.document;
    globalThis.Option = window.Option;
    const calls = [];
    const csv = 'Timestamp,SCT Version,Filename,MEAN(area)\r\n2026-10-04,7.3,"a,b.nii.gz",23.000000000000004\r\n';
    const done = { id: 'job1', status: 'succeeded', simulated: false, outputs: [{ name: 'morphometry.csv', contentType: 'text/csv' }] };
    const client = {
        baseUrl: 'https://compute.example',
        token: 'paired',
        pair: async () => {},
        info: async () => ({ service: 'neurodesk-compute', runner: 'docker', tools: [{ id: 'sct', version: SCT_VERSION, image: SCT_IMAGE }] }),
        jobs: async () => ({ jobs: [] }),
        submit: async (spec, files) => { calls.push({ spec, files }); return { id: 'job1' }; },
        watch: async () => done,
        output: async () => new Blob([csv]),
        cancel: async id => { calls.push({ cancel: id }); },
        ...overrides,
    };
    const messages = [];
    const progress = Object.fromEntries(['begin', 'end', 'reset', 'setText', 'setIndeterminate', 'setProgress', 'setCancellable', 'stopTimer'].map(method => [method, (...args) => messages.push([method, ...args])]));
    const analysis = new SctAnalysis({ before: document.getElementById('before'), progress, log: () => {} });
    analysis.connection.configure({ createClient: () => client });
    analysis.connection.address = client.baseUrl;
    analysis.connection.token = 'code';
    await analysis.connection.connect();
    return { analysis, calls, messages, client, csv, done, window };
}

const turn = () => new Promise(resolve => setImmediate(resolve));

test('standalone morphometry sends only explicit masks and preserves downloaded CSV bytes', async () => {
    const { analysis, calls, csv } = await setup();
    const file = new File(['mask bytes'], 'cord.nii.gz');
    analysis.uploaded.cord = file;
    analysis.slices.value = '2:12,15';
    analysis.perSlice.checked = true;
    analysis.angleCorrection.checked = false;
    assert.equal(calls.length, 0);
    await analysis.run();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].files.cord, file);
    assert.deepEqual(calls[0].spec, { tool: 'sct', command: 'process_segmentation', cord: 'cord', options: { perSlice: true, angleCorrection: false, slices: '2:12,15' } });
    assert.equal(await analysis.outputs['morphometry.csv'].file.text(), csv);
    assert.equal(analysis.table.querySelector('tr:last-child td:last-child').textContent, '23.000000000000004');
    assert.equal(analysis.resultSection.open, true);
});

test('lesion analysis supports no cord and current generated mask selection without submitting automatically', async () => {
    const { analysis, calls } = await setup();
    const lesion = new File(['lesion bytes'], 'generated-lesion.nii');
    analysis.setGenerated({ lesion });
    analysis.command.value = 'analyze_lesion';
    analysis.command.onchange();
    analysis.sources.lesion.value = 'generated';
    assert.equal(calls.length, 0);
    assert.equal(analysis.sources.cord.value, 'none');
    const captured = analysis.capture();
    assert.deepEqual(captured.spec, { tool: 'sct', command: 'analyze_lesion', lesion: 'lesion', options: {} });
    assert.equal(captured.files.lesion, lesion);
    analysis.setGenerated({});
    assert.equal(analysis.sources.lesion.value, 'upload');
    assert.throws(() => analysis.capture(), /Choose a lesion mask/);
});

test('cancel during upload waits for the job receipt then cancels server work', async () => {
    const submitted = deferred();
    const watched = deferred();
    const { analysis, calls, messages } = await setup({ submit: () => submitted.promise, watch: () => watched.promise });
    analysis.uploaded.cord = new File(['mask'], 'cord.nii');
    const running = analysis.run();
    await analysis.cancel();
    assert.equal(analysis.busy, true);
    submitted.resolve({ id: 'upload-race' });
    await turn();
    assert.deepEqual(calls, [{ cancel: 'upload-race' }]);
    assert.equal(analysis.busy, true);
    watched.resolve({ id: 'upload-race', outputs: [] });
    await running;
    assert.equal(analysis.busy, false);
    assert.ok(messages.some(([method, text]) => method === 'end' && text === 'Analysis cancelled'));
});

test('cancel after processing finishes clears busy state and never publishes partial downloads', async () => {
    const output = deferred();
    const { analysis, messages } = await setup({ output: () => output.promise });
    analysis.uploaded.cord = new File(['mask'], 'cord.nii');
    const running = analysis.run();
    await turn();
    await analysis.cancel();
    output.resolve(new Blob(['csv']));
    await running;
    assert.deepEqual(analysis.outputs, {});
    assert.ok(messages.some(([method, text]) => method === 'end' && text === 'Analysis cancelled'));
});

test('replaced inputs discard late output and allow retry with the new selection', async () => {
    const output = deferred();
    const { analysis } = await setup({ output: () => output.promise });
    analysis.uploaded.cord = new File(['old'], 'old.nii');
    const running = analysis.run();
    await turn();
    analysis.uploaded.cord = new File(['new'], 'new.nii');
    analysis.invalidate();
    output.resolve(new Blob(['old results']));
    await running;
    assert.equal(analysis.table.childElementCount, 0);
    assert.deepEqual(analysis.outputs, {});
    assert.equal(analysis.capture().files.cord.name, 'new.nii');
});

test('unsupported native runtime is rejected before upload and selected files remain retryable', async () => {
    const { analysis, calls, messages } = await setup({ info: async () => ({ service: 'neurodesk-compute', runner: 'native', tools: [{ id: 'sct', version: SCT_VERSION, image: SCT_IMAGE }] }) });
    analysis.uploaded.cord = new File(['mask'], 'cord.nii');
    await analysis.run();
    assert.equal(calls.length, 0);
    assert.equal(analysis.uploaded.cord.name, 'cord.nii');
    assert.ok(messages.some(([, text]) => String(text).includes('pinned SCT')));
});

test('SCT schemas keep native defaults and reject unsupported scientific options', () => {
    const spec = validateSctSpec({ tool: 'sct', command: 'process_segmentation', cord: 'cord' }, ['cord']);
    assert.deepEqual(sctArgv(spec, { cord: 'cord.nii' }), ['sct_process_segmentation', '-i', '/job/in/cord.nii', '-o', '/job/out/morphometry.csv']);
    for (const options of [{ slices: '4:1' }, { slices: '1;rm' }, { angleCorrection: 'yes' }, { perSlice: 1 }, { atlas: '/tmp' }]) {
        assert.throws(() => validateSctSpec({ ...spec, options }, ['cord']));
    }
    assert.deepEqual(parseMetricTable('A,B\r\n"x,y","a""b"\r\n'), [['A', 'B'], ['x,y', 'a"b']]);
});
