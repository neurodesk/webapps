import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { formatG, gunzip, openAtlas, toTsv } from '../src/index.js';

const exe = fileURLToPath(new URL('../../../exes/nii2tvx/', import.meta.url));
const fixtures = join(exe, 'test/fixtures');
const native = join(exe, 'nii2tvx');

/** Build the fixture atlas with the native tool, in a temp dir so conversion does not write
 *  into the committed fixtures. Returns null when the tool has not been built. */
function buildFixtureAtlas() {
  if (!existsSync(native)) return null;
  const work = mkdtempSync(join(tmpdir(), 'nii2tvx-'));
  cpSync(fixtures, work, { recursive: true });
  const run = (...args) => execFileSync(native, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  run('template.nii.gz', 'all_hit.trk', 'some_hit.trk', 'none_hit.trk', 'outside.trk');
  run('-p', 'atlas.tvx', 'all_hit.tvx', 'some_hit.tvx', 'none_hit.tvx', 'outside.tvx');
  return { work, run };
}

test('the WebAssembly module reproduces the native TSV on the fixtures', async (t) => {
  const built = buildFixtureAtlas();
  if (!built) return t.skip('build exes/nii2tvx first: make -C exes/nii2tvx');
  try {
    const atlas = await openAtlas(readFileSync(join(built.work, 'atlas.tvx')));
    assert.deepEqual(atlas.tracts, ['all_hit', 'some_hit', 'none_hit', 'outside']);

    const rows = [];
    for (const lesion of ['lesion', 'lesion_empty']) {
      rows.push({ id: lesion, fractions: await atlas.query(readFileSync(join(fixtures, `${lesion}.nii.gz`))) });
    }
    atlas.close();

    const expected = readFileSync(join(exe, 'test/expected.tsv'), 'utf8');
    assert.equal(toTsv(atlas.tracts, rows), expected);
    // An empty tract is "no data", not a failure, and must survive as nan rather than becoming 0.
    assert.ok(expected.includes('nan'));
  } finally {
    rmSync(built.work, { recursive: true, force: true });
  }
});

test('a lesion on a different grid is refused with the reason, not answered', async (t) => {
  const built = buildFixtureAtlas();
  if (!built) return t.skip('build exes/nii2tvx first');
  try {
    const atlas = await openAtlas(readFileSync(join(built.work, 'atlas.tvx')));
    await assert.rejects(
      () => atlas.query(readFileSync(join(fixtures, 'wrong_grid.nii.gz'))),
      /grid|dim|sto_xyz/i,
    );
    atlas.close();
  } finally {
    rmSync(built.work, { recursive: true, force: true });
  }
});

test('gzipped and plain inputs are accepted interchangeably', async (t) => {
  const built = buildFixtureAtlas();
  if (!built) return t.skip('build exes/nii2tvx first');
  try {
    const atlas = await openAtlas(readFileSync(join(built.work, 'atlas.tvx'))); // plain .tvx
    const gzipped = readFileSync(join(fixtures, 'lesion.nii.gz'));
    const plain = await gunzip(gzipped);
    assert.deepEqual(await atlas.query(plain), await atlas.query(gzipped));
    atlas.close();
  } finally {
    rmSync(built.work, { recursive: true, force: true });
  }
});

test('fractions format exactly as C printf("%g")', () => {
  // Every case where Number(x.toPrecision(6)) diverges, plus the ordinary ones.
  assert.equal(formatG(NaN), 'nan');
  assert.equal(formatG(0), '0');
  assert.equal(formatG(1), '1');
  assert.equal(formatG(0.55), '0.55');
  assert.equal(formatG(Math.fround(1 / 3)), '0.333333');
  assert.equal(formatG(Math.fround(1 / 30856)), '3.24086e-05'); // one streamline of IFOF_L
  assert.equal(formatG(1e-5), '1e-05');
  assert.equal(formatG(1e-7), '1e-07');
  assert.equal(formatG(1e-4), '0.0001');
});

// The real atlases, which live outside the repository.
for (const { file, golden, tracts } of [
  { file: 'hcp1065_avg_tracts.tvx', golden: 'test/expected-examples.tsv', tracts: 87 },
  // ENIGMA's bundle names run past 16 bytes, which is where Emscripten's UTF8ToString switches
  // to TextDecoder; the short HCP1065 names never exercise that path.
  { file: 'enigma_symmetric.tvx', golden: 'test/expected-examples-enigma.tsv', tracts: 65 },
]) {
  test(`the WebAssembly module reproduces the native TSV on ${file}`, async (t) => {
    const reference = process.env.NII2TVX_REFERENCE_DIR || join(process.env.HOME || '', 'src/nii2tvx');
    const atlasPath = join(reference, file);
    if (!existsSync(atlasPath)) return t.skip(`no atlas at ${atlasPath}; set NII2TVX_REFERENCE_DIR`);

    const atlas = await openAtlas(readFileSync(atlasPath));
    assert.equal(atlas.tracts.length, tracts);
    assert.ok(atlas.tracts.every((name) => /^[\w-]+$/.test(name)), 'every tract name decoded');
    const rows = [];
    // wM2017 was drawn on a T1, the other three on a T2.
    for (const lesion of ['wM2017_T1w', 'wM2018_T2w', 'wM2201_T2w', 'wM2208_T2w']) {
      rows.push({
        id: `${lesion}_lesion`,
        fractions: await atlas.query(readFileSync(join(reference, `examples2/${lesion}_lesion.nii.gz`))),
      });
    }
    atlas.close();
    assert.equal(toTsv(atlas.tracts, rows), readFileSync(join(exe, golden), 'utf8'));
  });
}
