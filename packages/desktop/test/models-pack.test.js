import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { modelsPack, writeTarGz } from '../../../scripts/desktop/models-pack.mjs';
import { withoutModels } from '../../../scripts/desktop/without-models.mjs';
import { createModelResolver } from '../src/models.js';
import { loadBundle } from '../src/bundle.js';

const hash = data => createHash('sha256').update(data).digest('hex');
const muscleUrl = 'https://models.example/musclemap-wholebody-v1.4-fp32.onnx';
const soloUrl = 'https://models.example/vessels.onnx';
const wheelUrl = 'https://wheels.example/numpy.whl';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'models-pack-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const full = join(root, 'full');
  await mkdir(join(full, 'site/demo'), { recursive: true });
  await mkdir(join(full, 'assets'));
  const muscle = Buffer.from('MUSCLEMAP whole body weights, split for hosting');
  const solo = Buffer.from('a vessel segmentation network');
  const wheel = Buffer.from('a python wheel that is not a model');
  const assets = {
    [muscleUrl]: { sha256: hash(muscle), bytes: muscle.length, kind: 'model', path: `assets/${hash(muscle)}` },
    [soloUrl]: { sha256: hash(solo), bytes: solo.length, kind: 'model', path: `assets/${hash(solo)}` },
    [wheelUrl]: { sha256: hash(wheel), bytes: wheel.length, kind: 'runtime', path: `assets/${hash(wheel)}` },
  };
  for (const [data, asset] of [[muscle, assets[muscleUrl]], [solo, assets[soloUrl]], [wheel, assets[wheelUrl]]]) await writeFile(join(full, asset.path), data);
  const head = muscle.subarray(0, 20);
  const tail = muscle.subarray(20);
  const files = {
    'site/demo/musclemap-wholebody-v1.4-fp32.part-00': { sha256: hash(head), bytes: head.length },
    'site/demo/musclemap-wholebody-v1.4-fp32.part-01': { sha256: hash(tail), bytes: tail.length },
    'site/demo/vessels.onnx': { sha256: hash(solo), bytes: solo.length },
    'site/demo/numpy.whl': { sha256: hash(wheel), bytes: wheel.length },
  };
  await writeFile(join(full, 'site/demo/index.html'), '<html>Demo</html>');
  await writeFile(join(full, 'site/demo/musclemap-wholebody-v1.4-fp32.part-00'), head);
  await writeFile(join(full, 'site/demo/musclemap-wholebody-v1.4-fp32.part-01'), tail);
  await writeFile(join(full, 'site/demo/vessels.onnx'), solo);
  await writeFile(join(full, 'site/demo/numpy.whl'), wheel);
  await writeFile(join(full, 'manifest.json'), JSON.stringify({ schemaVersion: 1, apps: [{ id: 'demo', path: 'demo' }], assets, files }));
  const light = join(root, 'light');
  await withoutModels(full, light);
  return { root, full, light, muscle, solo, wheel, head, tail };
}

test('the pack carries one entry per model asset, named by its hash, and nothing else', async t => {
  const { root, full, light, muscle, solo, wheel, head } = await fixture(t);
  const archive = join(root, 'release/webapps-0.1.20260915-models.tar.gz');
  const { models, release } = await modelsPack(full, light, archive, join(root, 'release/github'), { version: '0.1.20260915' });
  assert.deepEqual(models, [hash(muscle), hash(solo)].sort());
  const listed = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n').sort();
  assert.deepEqual(listed, [hash(muscle), hash(solo)].sort());
  assert.equal(listed.includes(hash(wheel)), false);
  assert.equal(listed.includes(hash(head)), false);
  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  assert.deepEqual(await readFile(join(extracted, hash(muscle))), muscle);
  assert.deepEqual(await readFile(join(extracted, hash(solo))), solo);
  assert.deepEqual((await readdir(extracted)).sort(), [hash(muscle), hash(solo)].sort());
  assert.equal(release.kind, 'models');
  assert.equal(release.platform, 'any');
  assert.equal(release.version, '0.1.20260915');
  assert.deepEqual(JSON.parse(await readFile(join(root, 'release/github/any.json'), 'utf8')), release);
});

test('an extracted pack resolves every model of the package without models, offline', async t => {
  const { root, full, light, muscle, solo, head, tail } = await fixture(t);
  const archive = join(root, 'release/webapps-0.1.20260915-models.tar.gz');
  await modelsPack(full, light, archive, join(root, 'release/github'), { version: '0.1.20260915' });
  const pack = join(root, 'pack');
  await mkdir(pack);
  execFileSync('tar', ['-xzf', archive, '-C', pack]);
  const resolver = createModelResolver(light, await loadBundle(light), join(root, 'cache'), { pack, fetchModel: () => { throw new Error('Must not fetch'); } });
  assert.equal(await resolver.asset(muscleUrl), join(pack, hash(muscle)));
  assert.deepEqual(await readFile(await resolver.file('site/demo/vessels.onnx')), solo);
  assert.deepEqual(await readFile(await resolver.file('site/demo/musclemap-wholebody-v1.4-fp32.part-00')), head);
  assert.deepEqual(await readFile(await resolver.file('site/demo/musclemap-wholebody-v1.4-fp32.part-01')), tail);
  assert.deepEqual((await readdir(join(root, 'cache'))).sort(), [hash(head), hash(tail)].sort());
});

test('a model whose bytes drifted from the pinned hash stops the pack', async t => {
  const { root, full, light } = await fixture(t);
  const bundle = await loadBundle(full);
  await writeFile(join(full, bundle.assets[soloUrl].path), 'tampered weights');
  await assert.rejects(
    modelsPack(full, light, join(root, 'release/models.tar.gz'), join(root, 'release/github'), { version: '0.1.20260915' }),
    /does not match its pinned hash/);
});

test('the same models produce the same archive bytes after the sources are rebuilt', async t => {
  const { root, full, light } = await fixture(t);
  const build = async name => {
    const archive = join(root, `release/${name}/webapps-0.1.20260915-models.tar.gz`);
    await modelsPack(full, light, archive, join(root, `release/${name}/github`), { version: '0.1.20260915' });
    return hash(await readFile(archive));
  };
  const first = await build('first');
  const rebuilt = new Date('2027-03-04T05:06:07Z');
  for (const entry of await readdir(join(full, 'assets'))) await utimes(join(full, 'assets', entry), rebuilt, rebuilt);
  assert.equal(await build('second'), first);
});

// bsdtar prints "mode links uid gid size date name" and GNU tar
// "mode uid/gid size date time name", so the size column depends on the tool.
function listedSizes(archive) {
  const sizes = {};
  for (const line of execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8' }).trim().split('\n')) {
    const fields = line.trim().split(/\s+/);
    sizes[fields.at(-1)] = Number(fields[1].includes('/') ? fields[2] : fields[4]);
  }
  return sizes;
}

const field = (tar, start, end) => tar.subarray(start, end).toString('latin1');

test('the archive is plain USTAR that the system tar lists and extracts, padded to whole blocks', async t => {
  const root = await mkdtemp(join(tmpdir(), 'models-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  const odd = Buffer.alloc(700, 'model bytes that end inside a block ');
  const exact = Buffer.alloc(512, 7);
  await writeFile(join(source, 'b-odd'), odd);
  await writeFile(join(source, 'a-empty'), '');
  await writeFile(join(source, 'c-exact'), exact);
  await writeFile(join(source, 'd-left-out'), 'not requested');
  const archive = join(root, 'pack.tar.gz');
  await writeTarGz(archive, source, ['c-exact', 'b-odd', 'a-empty']);

  assert.deepEqual(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'), ['a-empty', 'b-odd', 'c-exact']);
  assert.deepEqual(listedSizes(archive), { 'a-empty': 0, 'b-odd': 700, 'c-exact': 512 });
  const extracted = join(root, 'extracted');
  await mkdir(extracted);
  execFileSync('tar', ['-xzf', archive, '-C', extracted]);
  assert.deepEqual((await readdir(extracted)).sort(), ['a-empty', 'b-odd', 'c-exact']);
  assert.equal((await readFile(join(extracted, 'a-empty'))).length, 0);
  assert.deepEqual(await readFile(join(extracted, 'b-odd')), odd);
  assert.deepEqual(await readFile(join(extracted, 'c-exact')), exact);

  const gzip = await readFile(archive);
  assert.equal(gzip.subarray(0, 10).toString('hex'), '1f8b0800000000000003');
  const tar = gunzipSync(gzip);
  // header, header + 700 bytes padded to 1024, header + 512 bytes, two end blocks
  assert.equal(tar.length, 512 + 512 + 1024 + 512 + 512 + 1024);
  const header = tar.subarray(512, 1024);
  assert.equal(field(header, 0, 100), 'b-odd'.padEnd(100, '\0'));
  assert.equal(field(header, 100, 108), '0000644\0');
  assert.equal(field(header, 108, 116), '0000000\0');
  assert.equal(field(header, 116, 124), '0000000\0');
  assert.equal(field(header, 124, 136), '00000001274\0');
  assert.equal(field(header, 136, 148), '00000000000\0');
  assert.equal(field(header, 156, 157), '0');
  assert.equal(field(header, 257, 265), 'ustar\x0000');
  assert.equal(header.subarray(265, 329).every(byte => byte === 0), true);
  const blank = Buffer.from(header);
  blank.fill(' ', 148, 156);
  assert.equal(parseInt(field(header, 148, 154), 8), blank.reduce((sum, byte) => sum + byte, 0));
  assert.deepEqual(tar.subarray(1024, 1724), odd);
  assert.equal(tar.subarray(1724, 2048).every(byte => byte === 0), true);
  assert.equal(field(tar, 2048, 2055), 'c-exact');
  assert.equal(tar.subarray(tar.length - 1024).every(byte => byte === 0), true);
});

test('a name the USTAR header cannot hold stops the pack instead of being truncated', async t => {
  const root = await mkdtemp(join(tmpdir(), 'models-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const long = 'n'.repeat(101);
  await writeFile(join(root, long), 'x');
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/file'), 'x');
  await assert.rejects(writeTarGz(join(root, 'long.tar.gz'), root, [long]), /exceeds the 100 bytes/);
  await assert.rejects(writeTarGz(join(root, 'nested.tar.gz'), root, ['nested/file']), /not a flat file name/);
  await assert.rejects(writeTarGz(join(root, 'directory.tar.gz'), root, ['nested']), /not a regular file/);
});

test('archive bytes depend on the entries alone, not on when or in what order they were packed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'models-tar-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  await mkdir(source);
  await writeFile(join(source, 'one'), 'first model');
  await writeFile(join(source, 'two'), 'second model');
  await writeTarGz(join(root, 'first.tar.gz'), source, ['one', 'two']);
  const rebuilt = new Date('2031-01-02T03:04:05Z');
  for (const name of ['one', 'two']) await utimes(join(source, name), rebuilt, rebuilt);
  await writeTarGz(join(root, 'second.tar.gz'), source, ['two', 'one']);
  const first = await readFile(join(root, 'first.tar.gz'));
  assert.deepEqual(await readFile(join(root, 'second.tar.gz')), first);
  // The expected tar is assembled here from the specification, not by the packer.
  assert.equal(hash(gunzipSync(first)), hash(Buffer.concat([
    ustar('one', 11), Buffer.from('first model'.padEnd(512, '\0')),
    ustar('two', 12), Buffer.from('second model'.padEnd(512, '\0')),
    Buffer.alloc(1024),
  ])));
});

// An independent header built field by field from the tar specification.
function ustar(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0);
  header.write('0000644\0', 100);
  header.write('0000000\0', 108);
  header.write('0000000\0', 116);
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  header.write('00000000000\0', 136);
  header.write('        ', 148);
  header.write('0', 156);
  header.write('ustar\x0000', 257);
  const sum = header.reduce((total, byte) => total + byte, 0);
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return header;
}
