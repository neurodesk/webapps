import assert from 'node:assert/strict';
import test from 'node:test';
import { zipSync } from 'fflate';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { examinationFiles, expandInputs } from '../src/input.js';

const files = () => dicomSeries().map(({ name, buffer }) => new File([buffer], name));

test('folder and ZIP paths preserve colliding basenames and ignore ancillary files', async () => {
  const archive = new File([zipSync({ 'nested/a/IM0001': new Uint8Array(await files()[0].arrayBuffer()), 'nested/b/IM0001': new Uint8Array(await files()[1].arrayBuffer()) })], 'scanner.zip');
  const expanded = await expandInputs([archive]);
  assert.equal(expanded.length, 2);
  assert.notEqual(expanded[0]._webkitRelativePath, expanded[1]._webkitRelativePath);
  const result = await examinationFiles([...expanded, new File(['notes'], 'readme.txt')]);
  assert.equal(result.files.length, 2);
  assert.equal(result.skipped, 1);
});

test('mixed examinations are refused before conversion', async () => {
  const source = files();
  const changed = Buffer.from(await source[1].arrayBuffer());
  const uid = '1.2.826.0.1.3680043.10.543.99';
  const location = changed.indexOf(Buffer.from(uid), changed.indexOf(Buffer.from('Synthetic^Phantom')));
  assert.ok(location > 0);
  changed[location + uid.length - 1] = '8'.charCodeAt(0);
  await assert.rejects(examinationFiles([source[0], new File([changed], 'other.dcm')]), /one patient and one examination/);
});

test('unsafe archives, empty selections, invalid archives and aborted reads fail clearly', async () => {
  const unsafe = new File([zipSync({ '../outside.dcm': new Uint8Array([1]) })], 'unsafe.zip');
  await assert.rejects(expandInputs([unsafe]), /unsafe/);
  await assert.rejects(expandInputs([]), /Choose nonempty/);
  await assert.rejects(expandInputs([new File(['bad'], 'bad.zip')]));
  await assert.rejects(examinationFiles([new File(['notes'], 'notes.txt')]), /No MRI/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(expandInputs(files(), { signal: controller.signal }), { name: 'AbortError' });
});

test('folder paths and repeated imports are stable without mutating the source Files', async () => {
  const source = files()[0];
  Object.defineProperty(source, 'webkitRelativePath', { value: 'scanner/anat/IM0001' });
  const [first] = await expandInputs([source]);
  const [retry] = await expandInputs([source]);
  assert.equal(first._webkitRelativePath, 'input0/scanner/anat/IM0001');
  assert.equal(retry._webkitRelativePath, first._webkitRelativePath);
  assert.equal(source._webkitRelativePath, undefined);
});
