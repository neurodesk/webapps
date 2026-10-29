import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
