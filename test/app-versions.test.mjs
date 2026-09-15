import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import {
  DATE_VERSION, EMBEDDED_VERSION_SITES, LINKED_PACKAGES, applyRelease, embeddedVersionMismatches,
  nextVersion, planRelease, releaseDate, syncEmbeddedVersions, validateReleaseDate, workspacePackages,
} from '../scripts/lib/app-versions.mjs';

const registry = await loadAppsRegistry();
const packages = await workspacePackages();
const run = promisify(execFile);

test('every app is versioned MAJOR.MINOR.YYYYMMDD with a valid past date', () => {
  for (const app of registry.apps) {
    const pkg = [...packages.values()].find((item) => item.group === 'apps' && item.id === app.id);
    assert.ok(pkg, `${app.id} has a package.json`);
    assert.match(pkg.manifest.version, DATE_VERSION, `${app.id} version`);
    const date = pkg.manifest.version.split('.')[2];
    validateReleaseDate(date);
    assert.ok(date <= releaseDate(), `${app.id} release date ${date} must not be in the future`);
  }
});

test('embedded version strings and linked packages match their app', async () => {
  assert.deepEqual(await embeddedVersionMismatches(packages), []);
  for (const [linked, appId] of Object.entries(LINKED_PACKAGES)) {
    assert.ok(packages.get(linked), `${linked} exists`);
    assert.ok(registry.apps.some((app) => app.id === appId), `${appId} is registered`);
  }
});

test('MuscleMap releases stay on the supported upstream series', () => {
  const { manifest } = packages.get('musclemap');
  assert.equal(manifest.releaseSeries, '1.4');
  assert.equal(manifest.version.split('.').slice(0, 2).join('.'), manifest.releaseSeries);
});

test('date versions preserve bump semantics and reject invalid dates and downgrades', () => {
  assert.equal(nextVersion('1.4.7', 'patch', '20260910'), '1.4.20260910');
  assert.equal(nextVersion('1.4.20260930', 'patch', '20261001'), '1.4.20261001');
  assert.equal(nextVersion('1.4.20260910', 'minor', '20260911'), '1.5.20260911');
  assert.equal(nextVersion('1.4.20260910', 'major', '20260911'), '2.0.20260911');
  assert.throws(() => nextVersion('nope', 'patch', '20260911'), /Cannot derive/);
  assert.throws(() => nextVersion('1.4.20260910', 'patch', '20260909'), /downgrade/);
  for (const date of ['20260931', '20260229', '20261301', '2026011']) {
    assert.throws(() => validateReleaseDate(date), /date/i);
  }
  validateReleaseDate('20280229');
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'app-versions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const put = async (path, text) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), text);
  };
  const manifest = (path, data) => put(`${path}/package.json`, JSON.stringify(data));
  const json = async (path) => JSON.parse(await readFile(join(root, path, 'package.json'), 'utf8'));
  await manifest('.', { name: 'release-fixture', private: true, packageManager: 'pnpm@11.7.0' });
  await put('pnpm-workspace.yaml', "packages:\n  - apps/*\n  - packages/*\n");
  await put('.changeset/config.json', await readFile(join(repoRoot, '.changeset/config.json'), 'utf8'));
  await manifest('apps/zarro', {
    name: 'zarro', version: '0.1.20260930', private: true,
    dependencies: { '@neurodesk/webapp-components': 'workspace:*' },
  });
  await put('apps/zarro/src/config.js', "export const APP = { version: '0.1.20260930' };\n");
  await put('apps/zarro/CHANGELOG.md', '# zarro\n\n## 0.1.20260930\n\n### Patch Changes\n\n- Earlier work.\n');
  await manifest('packages/components', { name: '@neurodesk/webapp-components', version: '0.1.3' });
  await manifest('packages/unrelated', { name: 'unrelated', version: '1.0.0' });
  await manifest('apps/synthsr', { name: 'synthsr', version: '0.2.20260930', private: true });
  await manifest('packages/synthsr', { name: '@neurodesk/synthsr', version: '0.2.20260930' });
  await put('exes/synthsr/Cargo.toml', '[package]\nname = "synthsr"\nversion = "0.2.20260930"\n\n[dependencies]\nort = { version = "=2.0.0" }\n');
  await put('exes/synthsr/Cargo.lock', '[[package]]\nname = "synthsr"\nversion = "0.2.20260930"\n');
  await run('git', ['init', '-q', root]);
  await run('git', ['-C', root, 'add', '.']);
  await run('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Fixture']);
  return { root, put, json };
}

test('mixed shared changesets retain the strongest bump, attribution and dated dependents', async (t) => {
  const { root, put, json } = await fixture(t);
  await put('.changeset/a.md', '---\n"@neurodesk/webapp-components": minor\n---\n\nNew controls.\n');
  await put('.changeset/b.md', '---\n"@neurodesk/webapp-components": patch\n---\n\nControl fix.\n');
  await put('.changeset/c.md', '---\n"unrelated": patch\n---\n\nUnrelated fix.\n');
  const release = await planRelease(root, { date: '20261001' });
  assert.deepEqual(release.plan.releases.map(({ name, newVersion }) => [name, newVersion]).sort(), [
    ['@neurodesk/webapp-components', '0.2.0'], ['unrelated', '1.0.1'], ['zarro', '0.1.20261001'],
  ]);
  assert.equal((await json('apps/zarro')).version, '0.1.20260930', 'planning writes nothing');
  assert.equal((await readdir(join(root, '.changeset'))).filter((name) => name.endsWith('.md')).length, 3);
  await applyRelease(release);
  assert.equal((await json('packages/components')).version, '0.2.0');
  assert.equal((await json('apps/zarro')).version, '0.1.20261001');
  const changelog = await readFile(join(root, 'packages/components/CHANGELOG.md'), 'utf8');
  assert.match(changelog, /New controls/);
  assert.match(changelog, /Control fix/);
  assert.doesNotMatch(changelog, /Unrelated fix/);
  assert.deepEqual(await embeddedVersionMismatches(await workspacePackages(root), root), []);
  assert.deepEqual(await readdir(join(root, '.changeset')), ['config.json']);
});

test('a linked-package changeset releases the app, package and native versions together', async (t) => {
  const { root, put, json } = await fixture(t);
  await put('.changeset/a.md', '---\n"@neurodesk/synthsr": minor\n---\n\nNew synthesis method.\n');
  const release = await planRelease(root, { date: '20261001' });
  await applyRelease(release);
  assert.equal((await json('apps/synthsr')).version, '0.3.20261001');
  assert.equal((await json('packages/synthsr')).version, '0.3.20261001');
  assert.match(await readFile(join(root, 'packages/synthsr/CHANGELOG.md'), 'utf8'), /New synthesis method/);
  assert.match(await readFile(join(root, 'exes/synthsr/Cargo.toml'), 'utf8'), /ort = \{ version = "=2.0.0" \}/);
  assert.deepEqual(await embeddedVersionMismatches(await workspacePackages(root), root), []);
});

test('an app release automatically versions the complete desktop suite', async (t) => {
  const { root, put, json } = await fixture(t);
  await put('packages/desktop/package.json', JSON.stringify({ name: '@neurodesk/desktop', version: '0.1.20260930', private: true }));
  await put('.changeset/app.md', '---\n"zarro": patch\n---\n\nUpdated offline app.\n');
  const release = await planRelease(root, { date: '20261001' });
  assert.equal(release.plan.releases.find(item => item.name === '@neurodesk/desktop')?.newVersion, '0.1.20261001');
  await applyRelease(release);
  assert.equal((await json('packages/desktop')).version, '0.1.20261001');
});

test('same-day app updates get a distinct immutable suite version', async (t) => {
  const { root, put } = await fixture(t);
  await put('packages/desktop/package.json', JSON.stringify({ name: '@neurodesk/desktop', version: '0.1.20260930', private: true }));
  await put('.changeset/app.md', '---\n"zarro": patch\n---\n\nSame-day offline fix.\n');
  const release = await planRelease(root, { date: '20260930', sameDay: true });
  assert.equal(release.plan.releases.find(item => item.name === '@neurodesk/desktop')?.newVersion, '0.2.20260930');
});

test('an app release uses the strongest linked bump and updates pinned dependents to the final date', async (t) => {
  const { root, put, json } = await fixture(t);
  await put('packages/unrelated/package.json', JSON.stringify({
    name: 'unrelated', version: '1.0.0', dependencies: { '@neurodesk/synthsr': '0.2.20260930' },
  }));
  await put('.changeset/a.md', '---\n"synthsr": major\n"@neurodesk/synthsr": patch\n---\n\nBreaking synthesis change.\n');
  await applyRelease(await planRelease(root, { date: '20261001' }));
  assert.equal((await json('apps/synthsr')).version, '1.0.20261001');
  assert.equal((await json('packages/synthsr')).version, '1.0.20261001');
  assert.equal((await json('packages/unrelated')).dependencies['@neurodesk/synthsr'], '1.0.20261001');
  assert.deepEqual(await embeddedVersionMismatches(await workspacePackages(root), root), []);
});

test('same-day updates are explicit and retain one changelog version heading', async (t) => {
  const { root, put } = await fixture(t);
  await put('.changeset/a.md', "---\n'zarro': patch\n---\n\nSame-day fix.\n");
  await assert.rejects(planRelease(root, { date: '20260930' }), /already at/);
  await applyRelease(await planRelease(root, { date: '20260930', sameDay: true }));
  const changelog = await readFile(join(root, 'apps/zarro/CHANGELOG.md'), 'utf8');
  assert.equal(changelog.match(/^## 0\.1\.20260930$/gm).length, 1);
  assert.match(changelog, /Earlier work/);
  assert.match(changelog, /Same-day fix/);
});

test('upstream release series survives patch, minor and major webapp changes', async (t) => {
  const { root, put, json } = await fixture(t);
  const manifest = await json('apps/zarro');
  await put('apps/zarro/package.json', JSON.stringify({ ...manifest, releaseSeries: '0.1' }));
  for (const bump of ['patch', 'minor', 'major']) {
    await put('.changeset/a.md', `---\n"zarro": ${bump}\n---\n\nWebapp changes.\n`);
    const release = await planRelease(root, { date: '20261001' });
    assert.equal(release.plan.releases.find(({ name }) => name === 'zarro').newVersion, '0.1.20261001');
    await assert.rejects(planRelease(root, { date: '20260930' }), /already at/);
  }
  await applyRelease(await planRelease(root, { date: '20261001' }));
  assert.equal((await json('apps/zarro')).version, '0.1.20261001');
  assert.deepEqual(await embeddedVersionMismatches(await workspacePackages(root), root), []);
});

test('broken embedded version sites fail before consuming changesets or editing manifests', async (t) => {
  const { root, put, json } = await fixture(t);
  await put('.changeset/a.md', '---\n"zarro": patch\n---\n\nFix the viewer.\n');
  await put('apps/zarro/src/config.js', 'export const APP = {};\n');
  await assert.rejects(planRelease(root, { date: '20261001' }), /version site not found/);
  assert.equal((await json('apps/zarro')).version, '0.1.20260930');
  assert.match(await readFile(join(root, '.changeset/a.md'), 'utf8'), /Fix the viewer/);
  await rm(join(root, 'apps/zarro/src/config.js'));
  await assert.rejects(planRelease(root, { date: '20261001' }), { code: 'ENOENT' });
  assert.equal((await json('apps/zarro')).version, '0.1.20260930');
});

test('every embedded version site in the real repo resolves', async () => {
  for (const [appId, sites] of Object.entries(EMBEDDED_VERSION_SITES)) {
    for (const site of sites) {
      const text = await readFile(join(repoRoot, site.file), 'utf8');
      assert.ok(site.pattern.test(text), `${appId}: ${site.file} matches its version pattern`);
    }
  }
  const pkg = [...packages.values()].find((item) => item.id === 'zarro');
  assert.deepEqual(await syncEmbeddedVersions('zarro', pkg.manifest.version), []);
});
