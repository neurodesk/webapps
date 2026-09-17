import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readdir, readFile, utimes, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { modelsPack } from '../../../scripts/desktop/models-pack.mjs';
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
