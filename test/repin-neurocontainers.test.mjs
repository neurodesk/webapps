import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { applyRepins, parseApptainerName, repinnedEntry } from '../scripts/repin-neurocontainers.mjs';

const read = async (path) => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const release = { build: '20261025', digest: 'sha256:799b', releaseSha: 'e2f3049' };

test('an apptainer name gives the release metadata path', () => {
  assert.deepEqual(parseApptainerName('niimath_1.0.20260703_20260909'), { recipe: 'niimath', version: '1.0.20260703', build: '20260909' });
  assert.deepEqual(parseApptainerName('freesurfer_8.2.0_20261019'), { recipe: 'freesurfer', version: '8.2.0', build: '20261019' });
  assert.equal(parseApptainerName('not-a-build'), null);
});

test('a re-pinned record moves the image, tag, digest and recipe to the new build together', () => {
  const entry = {
    id: 'synthseg',
    label: 'synthseg 8.2.0 (20261016)',
    version: '8.2.0',
    buildDate: '20261016',
    image: 'vnmd/synthseg_8.2.0@sha256:f03b',
    digest: 'sha256:f03b',
    url: 'https://hub.docker.com/r/vnmd/synthseg_8.2.0',
    source: 'https://raw.githubusercontent.com/neurodesk/neurocontainers/103d/recipes/synthseg/build.yaml',
    dockerImage: 'vnmd/synthseg_8.2.0:20261016',
    apptainerUrl: 'https://neurocontainers.neurodesk.workers.dev/synthseg_8.2.0_20261016.simg',
    apptainerName: 'synthseg_8.2.0_20261016',
    apptainerSource: 'https://raw.githubusercontent.com/neurodesk/neurocommand/main/cvmfs/log.txt',
  };
  assert.deepEqual(repinnedEntry(entry, release), {
    ...entry,
    label: 'synthseg 8.2.0 (20261025)',
    buildDate: '20261025',
    image: 'vnmd/synthseg_8.2.0@sha256:799b',
    digest: 'sha256:799b',
    source: 'https://raw.githubusercontent.com/neurodesk/neurocontainers/e2f3049/recipes/synthseg/build.yaml',
    dockerImage: 'vnmd/synthseg_8.2.0:20261025',
    apptainerUrl: 'https://neurocontainers.neurodesk.workers.dev/synthseg_8.2.0_20261025.simg',
    apptainerName: 'synthseg_8.2.0_20261025',
  });
});

test('every Standalone container copied from a re-pinned record follows it, and nothing else changes', async () => {
  const registry = await read('../registry/neurocontainers.json');
  const standalone = await read('../registry/standalone.json');
  const before = structuredClone(standalone);
  const [key, entry] = Object.entries(registry.containers).find(([, value]) => value.apptainerUrl.includes('workers.dev'));
  const users = Object.entries(standalone.apps)
    .flatMap(([id, app]) => (app.containers ?? []).map((container, index) => ({ id, index, container })))
    .filter(({ container }) => container.apptainerName === entry.apptainerName);
  assert.ok(users.length > 0, `${key} is offered by a Standalone dialog`);
  const next = repinnedEntry(entry, release);
  applyRepins(registry, standalone, { [key]: next });
  assert.equal(registry.containers[key], next);
  for (const { id, index } of users) {
    const container = standalone.apps[id].containers[index];
    for (const field of ['label', 'dockerImage', 'apptainerUrl', 'apptainerName']) assert.equal(container[field], next[field], `${id}.${field}`);
    before.apps[id].containers[index] = container;
  }
  assert.deepEqual(standalone, before);
});

test('the CLI reports shared compute-server pins without changing them and still repairs eligible containers', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'repin-shared-pins-')));
  try {
    await mkdir(join(root, 'scripts'));
    await mkdir(join(root, 'registry'));
    for (const file of ['repin-neurocontainers.mjs', 'check-standalone-links.mjs']) {
      await copyFile(new URL(`../scripts/${file}`, import.meta.url), join(root, 'scripts', file));
    }
    const registry = await read('../registry/neurocontainers.json');
    const standalone = await read('../registry/standalone.json');
    const keys = ['nesvor', 'spinalcordtoolbox', 'synthseg'];
    registry.containers = Object.fromEntries(keys.map((key) => [key, registry.containers[key]]));
    await writeFile(join(root, 'registry/neurocontainers.json'), JSON.stringify(registry));
    await writeFile(join(root, 'registry/standalone.json'), JSON.stringify(standalone));
    const next = repinnedEntry(registry.containers.synthseg, release);
    const responses = {
      ...Object.fromEntries(keys.map((key) => [registry.containers[key].apptainerUrl, { status: 404 }])),
      [next.apptainerUrl]: { status: 200 },
      'https://api.github.com/repos/neurodesk/neurocontainers/commits?path=releases/synthseg/8.2.0.json&per_page=1': { body: [{ sha: release.releaseSha }] },
      [`https://raw.githubusercontent.com/neurodesk/neurocontainers/${release.releaseSha}/releases/synthseg/8.2.0.json`]: { body: { apps: { 'synthseg 8.2.0': { version: release.build } } } },
      [`https://hub.docker.com/v2/repositories/vnmd/synthseg_8.2.0/tags/${release.build}`]: { body: { digest: release.digest } },
    };
    const stub = join(root, 'fetch.mjs');
    await writeFile(stub, `const responses = ${JSON.stringify(responses)};
globalThis.fetch = async (url) => {
  const response = responses[url];
  if (!response) throw new Error('Unexpected network request: ' + url);
  return new Response(response.body ? JSON.stringify(response.body) : null, { status: response.status ?? 200 });
};
`);
    const bodyPath = join(root, 'body.md');
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(stub).href, join(root, 'scripts/repin-neurocontainers.mjs'), '--write', '--body', bodyPath], { encoding: 'utf8', timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(result.stdout);
    assert.deepEqual(summary.repinned, ['synthseg']);
    assert.deepEqual(summary.unresolved.map(({ key }) => key), ['nesvor', 'spinalcordtoolbox']);
    const updated = JSON.parse(await readFile(join(root, 'registry/neurocontainers.json'), 'utf8'));
    const updatedStandalone = JSON.parse(await readFile(join(root, 'registry/standalone.json'), 'utf8'));
    const body = await readFile(bodyPath, 'utf8');
    for (const key of ['nesvor', 'spinalcordtoolbox']) {
      assert.match(summary.unresolved.find((item) => item.key === key).reason, /coordinated update/);
      assert.deepEqual(updated.containers[key], registry.containers[key]);
      assert.match(body, new RegExp(`- ${key} .*coordinated update`));
    }
    assert.equal(updated.containers.synthseg.dockerImage, next.dockerImage);
    let repairedDownloads = 0;
    for (const [id, app] of Object.entries(standalone.apps)) {
      for (const [index, container] of (app.containers ?? []).entries()) {
        const changed = updatedStandalone.apps[id].containers[index];
        if (container.apptainerName === registry.containers.synthseg.apptainerName) {
          assert.equal(changed.apptainerName, next.apptainerName);
          repairedDownloads += 1;
        } else {
          assert.deepEqual(changed, container);
        }
      }
    }
    assert.ok(repairedDownloads > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

