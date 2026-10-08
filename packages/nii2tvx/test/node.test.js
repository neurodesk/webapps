import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gridAdvice, lesionId, tableName } from '../src/disconnectome.js';
import { ATLASES, DEFAULT_ATLAS, analyze, scoreLesion } from '../src/node.js';

const bin = fileURLToPath(new URL('../bin/disconnectome.js', import.meta.url));
const exe = fileURLToPath(new URL('../../../exes/nii2tvx/', import.meta.url));
const fixtures = join(exe, 'test/fixtures');
const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

async function workspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'disconnectome-cli-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, NEURODESK_OFFLINE: '1' } });

test('the packaged manifest is the app manifest, so both pin the same atlases', () => {
  assert.equal(read('../disconnectome.manifest.json'), read('../../../models/disconnectome.manifest.json'));
  assert.deepEqual(ATLASES.map((atlas) => atlas.id), ['enigma', 'hcp1065']);
  assert.equal(DEFAULT_ATLAS.id, 'enigma');
  for (const atlas of ATLASES) assert.match(atlas.asset.sha256, /^[0-9a-f]{64}$/);
});

test('the table is named after the lesion and the atlas, as the app names its download', () => {
  assert.equal(lesionId('wM2017_T1w_lesion.nii.gz'), 'wM2017_T1w_lesion');
  assert.equal(lesionId('sub-01.NII'), 'sub-01');
  assert.equal(tableName('wM2017_T1w_lesion', 'hcp1065'), 'wM2017_T1w_lesion_hcp1065_disconnectome.tsv');
});

test('offline, a missing atlas stops the run before anything is written', async (t) => {
  const directory = await workspace(t);
  const output = join(directory, 'results');
  await assert.rejects(
    analyze({ input: join(fixtures, 'lesion.nii.gz'), output, cacheDir: join(directory, 'atlases'), offline: true }),
    /enigma_symmetric\.tvx\.gz is missing from the offline atlas directory/,
  );
  await assert.rejects(readdir(output), { code: 'ENOENT' });
});

test('a cached atlas that fails its checksum is refused, not opened', async (t) => {
  const directory = await workspace(t);
  const cacheDir = join(directory, 'atlases');
  await mkdir(join(cacheDir, 'atlas'), { recursive: true });
  await writeFile(join(cacheDir, 'atlas/hcp1065_avg_tracts.tvx.gz'), 'not an atlas');
  await assert.rejects(
    analyze({ input: join(fixtures, 'lesion.nii.gz'), output: join(directory, 'results'), atlas: 'hcp1065', cacheDir, offline: true }),
    /hcp1065_avg_tracts\.tvx\.gz failed checksum verification/,
  );
});

test('an output directory that is not empty is refused and left untouched', async (t) => {
  const directory = await workspace(t);
  const output = join(directory, 'results');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'mine');
  await assert.rejects(analyze({ input: join(fixtures, 'lesion.nii.gz'), output, offline: true }), /not empty/);
  assert.deepEqual(await readdir(output), ['keep.txt']);
});

test('the executable rejects an unknown atlas, unknown options and wrong argument counts', () => {
  const atlas = run('lesion.nii.gz', 'out', '--atlas', 'jhu');
  assert.equal(atlas.status, 1);
  assert.match(atlas.stderr, /Unknown atlas "jhu"\. Choose enigma or hcp1065\./);
  const option = run('lesion.nii.gz', 'out', '--threshold', '0.5');
  assert.equal(option.status, 1);
  assert.match(option.stderr, /Unknown option '--threshold'/);
  const missing = run('lesion.nii.gz');
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /lesion mask and a new output directory/);
  const check = run('self-check');
  assert.equal(check.status, 0, check.stderr);
  assert.equal(JSON.parse(check.stdout).executable, process.execPath);
});

/** The fixture atlas, built by the native tool as packages/nii2tvx/test/parity.test.js does. */
function fixtureAtlas(t) {
  const native = join(exe, 'nii2tvx');
  if (!existsSync(native)) return null;
  const work = mkdtempSync(join(tmpdir(), 'nii2tvx-'));
  t.after(() => rm(work, { recursive: true, force: true }));
  cpSync(fixtures, work, { recursive: true });
  const build = (...args) => execFileSync(native, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
  build('template.nii.gz', 'all_hit.trk', 'some_hit.trk', 'none_hit.trk', 'outside.trk');
  build('-p', 'atlas.tvx', 'all_hit.tvx', 'some_hit.tvx', 'none_hit.tvx', 'outside.tvx');
  return readFileSync(join(work, 'atlas.tvx'));
}

test('a lesion off the atlas grid is refused with the app advice and the core reason', async (t) => {
  const atlas = fixtureAtlas(t);
  if (!atlas) return t.skip('build exes/nii2tvx first: make -C exes/nii2tvx');
  const scored = await scoreLesion(atlas, readFileSync(join(fixtures, 'lesion.nii.gz')));
  assert.deepEqual(scored.tracts, ['all_hit', 'some_hit', 'none_hit', 'outside']);
  const refusal = await scoreLesion(atlas, readFileSync(join(fixtures, 'wrong_grid.nii.gz'))).then(() => null, (error) => error);
  assert.ok(refusal, 'the wrong grid was answered');
  const [advice, reason] = refusal.message.split('\n');
  assert.equal(advice, gridAdvice({ dim: [182, 218, 182] }));
  assert.equal(advice, 'Not on the 182 × 218 × 182 MNI152 grid; normalize it with SYNcro first.');
  assert.match(reason, /grid|dim|sto_xyz/i);
});
