import assert from 'node:assert/strict';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { bindPageDrop, primaryInput, routeFiles } from '../src/ui/pageDrop.js';

const file = name => ({ name });

test('the primary input skips auxiliary kinds and disabled or folder inputs', () => {
  const { document } = new JSDOM(`<body>
    <input type="file" data-neurodesk-input="dataset" id="neurodesk-input-transfer" hidden>
    <input type="file" data-neurodesk-input="model" id="model">
    <input type="file" data-neurodesk-input="image" id="off" disabled>
    <input type="file" data-neurodesk-input="image" id="folder" webkitdirectory>
    <input type="file" data-neurodesk-input="dataset" id="spectra">
    <input type="file" data-neurodesk-input="image" id="t1"></body>`).window;
  assert.equal(primaryInput(document).id, 'spectra', 'LCModel: spectra, not the tissue T1 nor the automation input');
  document.getElementById('spectra').remove();
  assert.equal(primaryInput(document).id, 't1');
});

test('auxiliary files go to their own input and a scan fills each empty image slot', () => {
  const scan = { dataset: { neurodeskInput: 'image' } };
  const mask = { dataset: { neurodeskInput: 'image' } };
  const gradients = { dataset: { neurodeskInput: 'gradients' } };
  const plan = routeFiles([file('a.nii'), file('b.nii'), file('dwi.bval'), file('dwi.bvec')], [scan, mask, gradients], scan);
  assert.deepEqual(plan.map(([input, files]) => [input, files.map(f => f.name)]), [[scan, ['a.nii']], [mask, ['b.nii']], [gradients, ['dwi.bval', 'dwi.bvec']]]);
  const noGradientInput = routeFiles([file('a.nii'), file('dwi.bval')], [scan, mask], scan);
  assert.deepEqual(noGradientInput.map(([input, files]) => [input, files.length]), [[scan, 2]]);
  // FSL names its gradient files bvals and bvecs, with no stem.
  const fsl = routeFiles([file('data.nii.gz'), file('bvals'), file('bvecs')], [scan, mask, gradients], scan);
  assert.deepEqual(fsl.map(([input, files]) => [input, files.map(f => f.name)]), [[scan, ['data.nii.gz']], [gradients, ['bvals', 'bvecs']]]);
});

test('a mask input never takes dropped scans, so a DWI and its T1w stay together', () => {
  const { document } = new JSDOM(`<body>
    <input type="file" data-neurodesk-input="mask" id="dwiMask">
    <input type="file" data-neurodesk-input="image" id="images" multiple>
    <input type="file" data-neurodesk-input="mask" id="t1wMask"></body>`).window;
  const scan = primaryInput(document);
  assert.equal(scan.id, 'images', 'a mask input never leads, even when it comes first');
  const masks = [document.getElementById('dwiMask'), document.getElementById('t1wMask')];
  const files = ['sub-01_dwi.nii.gz', 'sub-01_dwi.bval', 'sub-01_dwi.bvec', 'sub-01_dwi.json', 'sub-01_T1w.nii.gz'].map(file);
  assert.deepEqual(routeFiles(files, [masks[0], scan, masks[1]], scan), [[scan, files]]);
});

test('a dropped BIDS diffusion dataset stays together at the primary input', () => {
  const scan = { dataset: { neurodeskInput: 'image' } };
  const mask = { dataset: { neurodeskInput: 'image' } };
  const gradients = { dataset: { neurodeskInput: 'gradients' } };
  const paths = ['ds/dwi.json', 'ds/sub-01/dwi/sub-01_run-1_dwi.nii.gz', 'ds/sub-01/dwi/sub-01_run-1_dwi.bval', 'ds/sub-01/dwi/sub-01_run-2_dwi.nii.gz'];
  const files = paths.map(path => ({ name: path.replace(/^.*\//, ''), _webkitRelativePath: path }));
  assert.deepEqual(routeFiles(files, [scan, mask, gradients], scan), [[scan, files]]);
  // A folder that is not a BIDS dataset still fills the image slots.
  const loose = ['scans/a.nii', 'scans/b.nii'].map(path => ({ name: path.replace(/^.*\//, ''), _webkitRelativePath: path }));
  assert.deepEqual(routeFiles(loose, [scan, mask], scan).map(([input, group]) => [input, group.length]), [[scan, 1], [mask, 1]]);
  // A BIDS folder without a DWI image, such as an anatomical pair, still fills the image slots.
  const anat = ['ds/sub-01/anat/sub-01_T1w.nii.gz', 'ds/sub-01/anat/sub-01_T2w.nii.gz'].map(path => ({ name: path.replace(/^.*\//, ''), _webkitRelativePath: path }));
  assert.deepEqual(routeFiles(anat, [scan, mask], scan).map(([input, group]) => [input, group.map(f => f.name)]), [[scan, ['sub-01_T1w.nii.gz']], [mask, ['sub-01_T2w.nii.gz']]]);
  // A session folder holds the DWI images of a longitudinal dataset.
  const session = ['ds/sub-01/ses-1/dwi/sub-01_ses-1_dwi.nii.gz', 'ds/sub-01/ses-2/dwi/sub-01_ses-2_dwi.nii.gz'].map(path => ({ name: path.replace(/^.*\//, ''), _webkitRelativePath: path }));
  assert.deepEqual(routeFiles(session, [scan, mask], scan), [[scan, session]]);
});

// jsdom has no DataTransfer; a drop carries file items and the input keeps whatever files it is given.
function dropSession(markup, t) {
  const { window } = new JSDOM(`<body>${markup}<footer id="status"></footer></body>`);
  // deliverFiles builds its events from the page's globals.
  Object.assign(globalThis, {
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    DataTransfer: class {
      items = { list: [], add: file => this.items.list.push(file) };
      get files() { return this.items.list; }
    },
  });
  const inputs = [...window.document.querySelectorAll('input')];
  const input = inputs[0];
  for (const field of inputs) Object.defineProperty(field, 'files', { get: () => field._files ?? [], set: files => { field._files = files; } });
  const pick = (...names) => {
    input.files = names.map(name => new window.File([], name));
    input.dispatchEvent(new window.Event('change', { bubbles: true }));
  };
  const dispatchDrop = items => {
    const event = new window.Event('drop', { bubbles: true, cancelable: true });
    event.dataTransfer = { types: ['Files'], items };
    window.document.body.dispatchEvent(event);
  };
  const settle = () => new Promise(resolve => setTimeout(resolve));
  const drop = async (...names) => {
    dispatchDrop(names.map(name => ({ getAsFile: () => new window.File([], name) })));
    await settle();
  };
  const deferredDrop = name => {
    let finish;
    dispatchDrop([{ webkitGetAsEntry: () => ({ isFile: true, file: callback => { finish = callback; } }) }]);
    return async () => {
      finish(new window.File([], name));
      await settle();
    };
  };
  const undo = () => window.document.querySelector('.nd-status-undo');
  const binding = bindPageDrop(window.document);
  t?.after(() => {
    binding.destroy();
    window.close();
  });
  return { window, input, inputs, pick, drop, deferredDrop, undo, binding };
}

test('loading an example withdraws a pending Undo', async t => {
  const { window, input, pick, drop, undo } = dropSession('<input type="file" data-neurodesk-input="image">', t);
  pick('a.nii');
  await drop('b.nii');
  assert.ok(undo());
  input.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'ready' } }));
  assert.equal(undo(), null);
});

test('Undo restores an appending input as its app last reported it', async t => {
  const { window, input, pick, drop, undo } = dropSession('<input type="file" data-neurodesk-input="image" data-appends>', t);
  pick('a.nii');
  pick('b.nii');
  input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [new window.File([], 'b.nii')] } }));
  await drop('c.nii');
  undo().click();
  assert.deepEqual([...input.files].map(f => f.name), ['b.nii']);
});

test('a loaded scan fills the next slot even when the app clears the picker', async t => {
  const { input, inputs, pick, drop } = dropSession('<input type="file" data-neurodesk-input="image"><input type="file" data-neurodesk-input="image">', t);
  const loaded = new Map();
  for (const field of inputs) field.addEventListener('change', () => {
    loaded.set(field, [...field.files].map(f => f.name));
    field.files = [];
  });
  pick('moving.nii.gz');
  await drop('stationary.nii.gz');
  assert.deepEqual(loaded.get(input), ['moving.nii.gz']);
  assert.deepEqual(loaded.get(inputs[1]), ['stationary.nii.gz']);
});

test('an input owner reports a loaded example and releases an empty slot', async t => {
  const { window, input, inputs, drop } = dropSession('<input type="file" data-neurodesk-input="image"><input type="file" data-neurodesk-input="image">', t);
  const report = files => input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files } }));
  report([new window.File([], 'example-moving.nii.gz')]);
  input.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'ready' } }));
  await drop('stationary.nii.gz');
  assert.deepEqual([...inputs[1].files].map(f => f.name), ['stationary.nii.gz']);
  report([]);
  await drop('new-moving.nii.gz');
  assert.deepEqual([...input.files].map(f => f.name), ['new-moving.nii.gz']);
});

test('Undo restores the loaded files reported by a completed example', async t => {
  const { window, input, drop, undo } = dropSession('<input type="file" data-neurodesk-input="image">', t);
  input.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'loading' } }));
  input.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: [new window.File([], 'example.nii.gz')] } }));
  input.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'ready' } }));
  await drop('replacement.nii.gz');
  assert.ok(undo(), 'replacing a loaded example offers Undo');
  undo().click();
  assert.deepEqual([...input.files].map(f => f.name), ['example.nii.gz']);
});

test('DICOM slices and their sidecars remain one batch at the primary input', async t => {
  const { inputs, drop } = dropSession('<input type="file" data-neurodesk-input="image"><input type="file" data-neurodesk-input="image">', t);
  await drop('slice1.dcm', 'slice2.dcm', 'series.json');
  assert.deepEqual([...inputs[0].files].map(f => f.name), ['slice1.dcm', 'slice2.dcm', 'series.json']);
  assert.deepEqual([...inputs[1].files], []);
});

test('a newer drop wins over an earlier traversal that finishes later', async t => {
  const { input, drop, deferredDrop } = dropSession('<input type="file" data-neurodesk-input="image">', t);
  const finishEarlier = deferredDrop('earlier.nii');
  await drop('newer.nii');
  await finishEarlier();
  assert.deepEqual([...input.files].map(f => f.name), ['newer.nii']);
});

test('choosing files withdraws Undo and supersedes a pending traversal', async t => {
  const { input, pick, drop, deferredDrop, undo } = dropSession('<input type="file" data-neurodesk-input="image">', t);
  pick('original.nii');
  await drop('replacement.nii');
  assert.ok(undo());
  const finishEarlier = deferredDrop('earlier.nii');
  pick('chosen.nii');
  await finishEarlier();
  assert.deepEqual([...input.files].map(f => f.name), ['chosen.nii']);
  assert.equal(undo(), null);
});

test('an example supersedes a pending traversal before it can commit', async t => {
  const { window, input, deferredDrop, undo } = dropSession('<input type="file" data-neurodesk-input="image">', t);
  const finishEarlier = deferredDrop('earlier.nii');
  input.dispatchEvent(new window.CustomEvent('nd-example-status', { bubbles: true, detail: { state: 'ready' } }));
  await finishEarlier();
  assert.deepEqual([...input.files], []);
  assert.equal(undo(), null);
});

test('destroying the drop binding prevents a pending traversal from committing', async t => {
  const { input, deferredDrop, binding } = dropSession('<input type="file" data-neurodesk-input="image">', t);
  const finishEarlier = deferredDrop('earlier.nii');
  binding.destroy();
  await finishEarlier();
  assert.deepEqual([...input.files], []);
});

test('promise-valued nd-file-field events do not become appending-input snapshots', async t => {
  const { window, input, pick, drop, undo } = dropSession('<nd-file-field><input type="file" data-neurodesk-input="image"></nd-file-field>', t);
  const errors = [];
  window.addEventListener('error', event => {
    errors.push(event.error.message);
    event.preventDefault();
  });
  pick('original.nii');
  input.parentElement.dispatchEvent(new window.CustomEvent('nd-files', { bubbles: true, detail: { files: Promise.resolve([new window.File([], 'original.nii')]) } }));
  await drop('replacement.nii');
  undo().click();
  assert.deepEqual([...input.files].map(f => f.name), ['original.nii']);
  assert.deepEqual(errors, []);
});

test('a drop on a canvas inside a shadow root, as FreeBrowse renders NiiVue, opens through the inputs', async t => {
  const { window, input } = dropSession('<input type="file" data-neurodesk-input="image"><div id="viewer"></div>', t);
  const canvas = window.document.createElement('canvas');
  window.document.getElementById('viewer').attachShadow({ mode: 'open' }).append(canvas);
  // NiiVue takes canvas drops itself, even with its own loading switched off.
  let reachedCanvas = false;
  canvas.addEventListener('drop', event => {
    reachedCanvas = true;
    event.preventDefault();
  });
  const event = new window.Event('drop', { bubbles: true, cancelable: true, composed: true });
  event.dataTransfer = { types: ['Files'], items: [{ getAsFile: () => new window.File([], 'scan.dcm') }] };
  canvas.dispatchEvent(event);
  await new Promise(resolve => setTimeout(resolve));
  assert.equal(reachedCanvas, false, 'the page drop takes it in the capture phase');
  assert.deepEqual([...input.files].map(f => f.name), ['scan.dcm']);
});
