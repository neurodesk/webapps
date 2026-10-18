import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dicomSeries } from '../../../test-utils/dicom-fixture.mjs';
import { indexFiles } from '../src/dicom-index.js';
import { FORMAT_VERSION, openSavedConversions, seriesFingerprint } from '../src/saved-conversions.js';

const toFile = ({ name, buffer }, path, lastModified = 0) => Object.assign(new File([buffer], name, { lastModified }), { _webkitRelativePath: path ?? `scan/${name}` });

async function indexed(options, { path, lastModified } = {}) {
  const files = dicomSeries(options).map((file) => toFile(file, path?.(file), lastModified));
  return (await indexFiles(files)).series[0];
}

test('the fingerprint follows the series content, not the file dates or order', async () => {
  const a = await indexed({ series: 3, slices: 3 });
  const b = await indexed({ series: 3, slices: 3 }, { lastModified: 123456 });
  assert.match(await seriesFingerprint(a), /^[0-9a-f]{64}$/);
  assert.equal(await seriesFingerprint(a), await seriesFingerprint(b));
  const reversed = { ...a, files: [...a.files].reverse() };
  assert.equal(await seriesFingerprint(reversed), await seriesFingerprint(a));
  const moved = await indexed({ series: 3, slices: 3 }, { path: (file) => `other/${file.name}` });
  assert.notEqual(await seriesFingerprint(moved), await seriesFingerprint(a), 'the path is part of the key');
  const fewer = await indexed({ series: 3, slices: 2 });
  assert.notEqual(await seriesFingerprint(fewer), await seriesFingerprint(a));
  const other = await indexed({ series: 4, slices: 3 });
  assert.notEqual(await seriesFingerprint(other), await seriesFingerprint(a));
  const header = dicomSeries({ series: 3, slices: 3 });
  header[0].buffer = Buffer.from(header[0].buffer);
  header[0].buffer.write('30', header[0].buffer.indexOf(Buffer.from([0x81, 0x00, 0x44, 0x53])) + 8, 'latin1');
  const changed = (await indexFiles(header.map((file) => toFile(file)))).series[0];
  assert.notEqual(await seriesFingerprint(changed), await seriesFingerprint(a), 'a header byte is part of the key');
  const pixels = dicomSeries({ series: 3, slices: 3 });
  pixels[2].buffer = Buffer.from(pixels[2].buffer);
  pixels[2].buffer[pixels[2].buffer.length - 1] ^= 1;
  const repainted = (await indexFiles(pixels.map((file) => toFile(file)))).series[0];
  assert.notEqual(await seriesFingerprint(repainted), await seriesFingerprint(a), 'a pixel byte is part of the key');
  assert.ok(a.files.every((record) => record.headerBytes !== null));
});

// An in-memory stand-in for the origin private file system's directory handles.
class FakeDirectory {
  constructor() { this.entries = new Map(); }

  async getDirectoryHandle(name, { create = false } = {}) {
    let entry = this.entries.get(name);
    if (!entry) {
      if (!create) throw new DOMException(`No ${name}`, 'NotFoundError');
      entry = new FakeDirectory();
      this.entries.set(name, entry);
    }
    return entry;
  }

  async getFileHandle(name, { create = false } = {}) {
    let entry = this.entries.get(name);
    if (!entry) {
      if (!create) throw new DOMException(`No ${name}`, 'NotFoundError');
      entry = new FakeFile();
      this.entries.set(name, entry);
    }
    return entry;
  }

  async removeEntry(name) {
    if (!this.entries.delete(name)) throw new DOMException(`No ${name}`, 'NotFoundError');
  }
}

class FakeFile {
  constructor() { this.parts = []; }

  async getFile() { return new File(this.parts, 'f'); }

  async createWritable() {
    const parts = [];
    return { write: async (data) => { parts.push(data); }, close: async () => { this.parts = parts; } };
  }
}

test('saved outputs round-trip with their names, bytes, sidecars and order, and are forgotten together', async () => {
  const root = new FakeDirectory();
  let persisted = 0;
  const store = await openSavedConversions({ root: async () => root, persist: () => { persisted += 1; } });
  assert.equal(await store.load('k1'), null);
  const outputs = [
    { image: new File([new Uint8Array([1, 2, 3])], 'e1.nii', { type: 'application/octet-stream' }), sidecar: { EchoTime: 0.02 } },
    { image: new File([new Uint8Array([4])], 'e2.nii'), sidecar: null },
  ];
  await store.save('k1', outputs);
  await store.save('k2', outputs.slice(1));
  assert.equal(persisted, 1, 'persistence is requested once');
  const loaded = await store.load('k1');
  assert.deepEqual(loaded.map(({ image, sidecar }) => [image.name, image.type, sidecar]), [['e1.nii', 'application/octet-stream', { EchoTime: 0.02 }], ['e2.nii', '', null]]);
  assert.deepEqual([...new Uint8Array(await loaded[0].image.arrayBuffer())], [1, 2, 3]);
  await store.save('k1', outputs.slice(0, 1));
  assert.equal((await store.load('k1')).length, 1, 'a save replaces the earlier one');
  await store.forget();
  assert.equal(await store.load('k1'), null);
  assert.equal(await store.load('k2'), null);
  await store.forget();
});

test('an unfinished save and a save of another format read as absent; no file system means no store', async () => {
  const root = new FakeDirectory();
  const store = await openSavedConversions({ root: async () => root, persist: () => {} });
  const dir = await (await root.getDirectoryHandle('dicomview', { create: true })).getDirectoryHandle('half', { create: true });
  const writable = await (await dir.getFileHandle('0', { create: true })).createWritable();
  await writable.write(new Uint8Array([1]));
  await writable.close();
  assert.equal(await store.load('half'), null);
  const old = await (await root.getDirectoryHandle('dicomview')).getDirectoryHandle('old', { create: true });
  const manifest = await (await old.getFileHandle('manifest.json', { create: true })).createWritable();
  await manifest.write(JSON.stringify({ version: `${FORMAT_VERSION}-not`, outputs: [] }));
  await manifest.close();
  assert.equal(await store.load('old'), null);
  assert.equal(await openSavedConversions({ root: async () => { throw new Error('no storage'); } }), null);
});
