import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import test from 'node:test';

const script = await readFile(new URL('../site/dicompare-routes.js', import.meta.url), 'utf8');
const origin = 'https://webapps.neurodesk.org';
function visit(route) {
  const location = new URL(route, origin);
  let redirected;
  let restored;
  location.replace = value => { redirected = value; };
  vm.runInNewContext(script, { location, URL, history: {
    state: { example: true },
    replaceState(state, title, value) {
      assert.deepEqual(state, { example: true });
      restored = value;
    },
  } });
  return { redirected, restored };
}

for (const route of [
  '/dicompare/schema',
  '/dicompare/schema/',
  '/dicompare/schema/ASL_Clinical_Guidelines_v1.0',
  '/dicompare/schema/uploaded_123/?acq=0#section',
  '/dicompare/schema/custom%20schema?x=%26%3D%2B&x=two+words#%E2%9C%93',
  '/dicompare/schema?url=https%3A%2F%2Fexample.org%2Fschema.json%3Fa%3D1%26b%3D2&acq=0#details',
]) {
  test(`Pages round trip preserves ${route}`, () => {
    const first = visit(route);
    assert.ok(first.redirected.startsWith('/dicompare/#'));
    assert.equal(first.restored, undefined);
    const second = visit(first.redirected);
    assert.equal(second.restored, route);
    assert.equal(second.redirected, undefined);
  });
}

for (const route of [
  '/', '/missing', '/dicompare/', '/dicompare/missing', '/dicompare/schema/a/b',
  '/dicompare/assets/missing.js', '/another/schema',
  '/dicompare/#__neurodesk_dicompare_route=%',
  '/dicompare/#__neurodesk_dicompare_route=https%3A%2F%2Fevil.example%2Fdicompare%2Fschema',
  '/dicompare/#__neurodesk_dicompare_route=%2Fmissing',
]) {
  test(`does not redirect or restore ${route}`, () => {
    assert.deepEqual(visit(route), { redirected: undefined, restored: undefined });
  });
}

test('composite staging copies the bridge and restores before app modules, idempotently', async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { fileURLToPath } = await import('node:url');
  const { stageDicompareRoutes } = await import('../scripts/lib/dicompare-routes.mjs');
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const siteDist = await mkdtemp(join(tmpdir(), 'dicompare-routes-'));
  try {
    await mkdir(join(siteDist, 'dicompare'));
    const index = join(siteDist, 'dicompare/index.html');
    await writeFile(index, '<html><head><script src="./coi-serviceworker.js"></script><base href="/dicompare/"><script type="module" src="/dicompare/assets/app.js"></script></head><body></body></html>');
    await stageDicompareRoutes({ repoRoot, siteDist });
    const first = await readFile(index, 'utf8');
    assert.match(first, /<script src="\/dicompare-routes\.js"><\/script>/);
    assert.ok(first.indexOf('/dicompare-routes.js') < first.indexOf('type="module"'));
    assert.ok(first.indexOf('<base ') < first.indexOf('/dicompare-routes.js'));
    assert.match(first, /<script src="\.\/coi-serviceworker\.js"><\/script>/);
    assert.ok(first.indexOf('<base ') < first.indexOf('./coi-serviceworker.js'));
    assert.equal((first.match(/<base /g) || []).length, 1);
    assert.match(first, /<base href="\/dicompare\/">/);
    for (const file of ['404.html', 'dicompare-routes.js']) {
      assert.equal(await readFile(join(siteDist, file), 'utf8'), await readFile(join(repoRoot, 'site', file), 'utf8'));
    }
    await stageDicompareRoutes({ repoRoot, siteDist });
    assert.equal(await readFile(index, 'utf8'), first);
    await writeFile(index, '<html><head><base href="./"></head></html>');
    await assert.rejects(stageDicompareRoutes({ repoRoot, siteDist }), /requires a \/dicompare\/ document base/);
  } finally {
    await rm(siteDist, { recursive: true, force: true });
  }
});
