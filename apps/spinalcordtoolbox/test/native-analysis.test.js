import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { SctAnalysis, jobLabel, parseMetricTable } from '../web/js/controllers/SctAnalysis.js';
import { SCT_IMAGE, SCT_VERSION, validateSctSpec, sctArgv } from '../web/js/app/analysis-spec.js';

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

async function setup(overrides = {}, browserRunner = null) {
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
    const analysis = new SctAnalysis({ before: document.getElementById('before'), progress, log: () => {}, ...(browserRunner ? { createBrowserRunner: () => browserRunner } : {}) });
    if (browserRunner) return { analysis, calls, messages, client, csv, done, window };
    analysis.execution.value = 'server';
    analysis.execution.onchange();
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

test('clearing generated results keeps analysis of uploaded masks and cancels analysis of generated ones', async () => {
    const watched = deferred();
    const { analysis, calls } = await setup({ watch: () => watched.promise });
    analysis.setGenerated({ cord: new File(['generated'], 'generated.nii') });
    analysis.uploaded.cord = new File(['uploaded'], 'uploaded.nii');
    const uploadedRun = analysis.run();
    await turn();
    analysis.setGenerated({});
    assert.equal(analysis.busy, true);
    assert.equal(calls.filter(call => call.cancel).length, 0);
    watched.resolve({ id: 'job1', outputs: [] });
    await uploadedRun;

    const generated = new File(['generated'], 'generated.nii');
    analysis.setGenerated({ cord: generated });
    analysis.sources.cord.value = 'generated';
    const pending = deferred();
    analysis.connection.client.watch = () => pending.promise;
    const generatedRun = analysis.run();
    await turn();
    analysis.setGenerated({ cord: generated });
    assert.equal(calls.filter(call => call.cancel).length, 0);
    analysis.setGenerated({});
    assert.deepEqual(calls.filter(call => call.cancel), [{ cancel: 'job1' }]);
    pending.resolve({ id: 'job1', outputs: [] });
    await generatedRun;
});

test('a server-confirmed cancellation reports one cancelled status', async () => {
    const watched = deferred();
    const { analysis, messages } = await setup({ watch: () => watched.promise });
    analysis.uploaded.cord = new File(['mask'], 'cord.nii');
    const running = analysis.run();
    await turn();
    await analysis.cancel();
    watched.resolve(Promise.reject(Object.assign(new Error('Job was cancelled'), { code: 'cancelled' })));
    await running;
    const ends = messages.filter(([method]) => method === 'end');
    assert.deepEqual(ends, [['end', 'Analysis cancelled', { success: false }]]);
});

test('previous jobs are labelled by analysis name', () => {
    assert.match(jobLabel({ command: 'process_segmentation', status: 'succeeded', createdAt: '2026-10-04T03:00:00Z' }), /^Cord morphometry · succeeded · (?!2026-10-04T)/);
    assert.equal(jobLabel({ command: 'analyze_lesion', status: 'running', createdAt: 'unknown' }), 'Lesion analysis · running · unknown');
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

test('browser analysis needs no server and preserves mask inputs and every artifact byte', async () => {
    const bytes = new Uint8Array([0, 255, 128, 1]);
    let request;
    const { analysis, calls } = await setup({}, {
        run: async value => { request = value; return [{ name: 'lesion_analysis.xlsx', contentType: 'application/octet-stream', bytes }]; },
        cancel: () => {},
    });
    const cord = new File(['original mask'], 'cord.nii');
    analysis.uploaded.cord = cord;
    assert.equal(analysis.execution.value, 'browser');
    assert.equal(analysis.computePanel.hidden, true);
    assert.equal(analysis.previousPanel.hidden, true);
    await analysis.run();
    assert.equal(request.files.cord, cord);
    assert.deepEqual(request.spec, analysis.capture().spec);
    assert.deepEqual(calls, []);
    assert.deepEqual(new Uint8Array(await analysis.outputs['lesion_analysis.xlsx'].file.arrayBuffer()), bytes);
    assert.match(analysis.resultNote.textContent, /WebAssembly results may differ/);
    assert.equal(analysis.busy, false);
});

test('browser cancellation clears busy state and allows retry', async () => {
    let rejectRun;
    let attempts = 0;
    const { analysis, messages } = await setup({}, {
        run: () => {
            attempts += 1;
            return attempts === 1 ? new Promise((_resolve, reject) => { rejectRun = reject; }) : Promise.resolve([]);
        },
        cancel: () => rejectRun(new DOMException('Cancelled', 'AbortError')),
    });
    analysis.uploaded.cord = new File(['mask'], 'cord.nii');
    const running = analysis.run();
    assert.equal(analysis.busy, true);
    await analysis.cancel();
    await running;
    assert.equal(analysis.busy, false);
    assert.deepEqual(analysis.outputs, {});
    assert.ok(messages.some(([method, text]) => method === 'end' && text === 'Analysis cancelled'));
    await analysis.run();
    assert.equal(attempts, 2);
    assert.equal(analysis.resultSection.open, true);
});

test('browser late results from replaced inputs are discarded', async () => {
    const pending = deferred();
    const { analysis } = await setup({}, { run: () => pending.promise, cancel: () => {} });
    analysis.uploaded.cord = new File(['old'], 'old.nii');
    const running = analysis.run();
    analysis.uploaded.cord = new File(['new'], 'new.nii');
    analysis.invalidate();
    pending.resolve([{ name: 'morphometry.csv', contentType: 'text/csv', bytes: new TextEncoder().encode('A\nold\n') }]);
    await running;
    assert.deepEqual(analysis.outputs, {});
    assert.equal(analysis.table.childElementCount, 0);
    assert.equal(analysis.resultSection.open, false);
    assert.equal(analysis.capture().files.cord.name, 'new.nii');
});

test('browser runner errors keep masks retryable and report the failure', async () => {
    const { analysis, messages } = await setup({}, { run: async () => { throw new Error('Runtime failed'); }, cancel: () => {} });
    analysis.uploaded.cord = new File(['mask'], 'cord.nii');
    await analysis.run();
    assert.equal(analysis.busy, false);
    assert.equal(analysis.uploaded.cord.name, 'cord.nii');
    assert.deepEqual(analysis.outputs, {});
    assert.ok(messages.some(([method, text]) => method === 'end' && text === 'Analysis failed: Runtime failed'));
});

test('the SCT image pin is identical everywhere it is declared', async () => {
    const read = path => readFile(new URL(`../../../${path}`, import.meta.url), 'utf8');
    assert.equal(JSON.parse(await read('registry/neurocontainers.json')).containers.spinalcordtoolbox.image, SCT_IMAGE);
    assert.ok((await read('exes/compute-server/src/tools/sct.rs')).includes(`pub const IMAGE: &str = "${SCT_IMAGE}";`));
    assert.ok((await read('exes/compute-server/src/tools/sct.rs')).includes(`pub const VERSION: &str = "${SCT_VERSION}";`));
    for (const path of ['docs/architecture/remote-compute-protocol.md', 'exes/compute-server/README.md', 'apps/spinalcordtoolbox/README.md']) {
        assert.ok((await read(path)).includes(SCT_IMAGE), path);
    }
});
