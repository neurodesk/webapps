// Conformance suite for the HPC features of the remote compute protocol:
// single-owner mode, data roots, projects and the simulated relion tool
// (docs/architecture/remote-compute-protocol.md, ADR-0004).
//
// By default it starts two Node reference servers: one with `singleOwner`
// and a temporary data root, one in the default per-pairing mode. To run it
// against the Rust server instead, start
//   neurodesk-compute serve --single-owner --runner simulate \
//     --data-root facility=<empty dir> --max-download-bytes 65536
// and set COMPUTE_SERVER_HPC_URL, COMPUTE_SERVER_HPC_TOKEN (the pairing code)
// and COMPUTE_SERVER_HPC_ROOT (the same directory; this suite fills it).
// The per-pairing checks use COMPUTE_SERVER_URL/COMPUTE_SERVER_TOKEN when set.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startReferenceServer } from '../test-utils/compute-reference-server.mjs';
import { parseStar, readMrcHeader, writeMrc } from '../test-utils/relion-simulator.mjs';
import { syntheticNifti } from '../test-utils/nifti-fixture.mjs';
import { createComputeClient, ComputeError } from '../packages/components/src/compute/index.js';
import { RELION_COMMANDS } from '../packages/cryo-em/src/spec.js';

const external = process.env.COMPUTE_SERVER_HPC_URL;
const pairingCode = process.env.COMPUTE_SERVER_HPC_TOKEN || 'test-token';
const externalPairing = process.env.COMPUTE_SERVER_URL;
const pairingModeCode = process.env.COMPUTE_SERVER_TOKEN || 'test-token';
const ROOT = 'facility';
const DOWNLOAD_LIMIT = 64 * 1024;
const PAGING_FILES = 1005;

let workDir;
let rootDir;
let server = null;
let pairingServer = null;
let baseUrl = external;
let pairingUrl = externalPairing;
let token;

function buildFixture(root, outside) {
  for (const name of ['2026-11', 'links', 'paging', 'vanishing', 'gain']) rmSync(join(root, name), { recursive: true, force: true });
  const grid = join(root, '2026-11/grid3');
  mkdirSync(join(grid, 'raw'), { recursive: true });
  for (const index of [1, 2, 3]) writeFileSync(join(grid, `FoilHole_${index}.tiff`), `simulated movie ${index}\n`);
  writeFileSync(join(grid, '.hidden.tiff'), 'hidden\n');
  writeFileSync(join(grid, 'notes.txt'), 'notes\n');
  writeFileSync(join(grid, 'raw/frame.tiff'), 'frame\n');
  mkdirSync(join(root, 'links'));
  symlinkSync(join(outside, 'secret.tiff'), join(root, 'links/escape.tiff'));
  symlinkSync(outside, join(root, 'links/escape-dir'));
  symlinkSync('../2026-11/grid3/FoilHole_1.tiff', join(root, 'links/inside.tiff'));
  mkdirSync(join(root, 'paging'));
  for (let index = 0; index < PAGING_FILES; index += 1) writeFileSync(join(root, 'paging', `file-${String(index).padStart(4, '0')}.tiff`), '');
  mkdirSync(join(root, 'vanishing'));
  for (const name of ['a.tiff', 'b.tiff']) writeFileSync(join(root, 'vanishing', name), `simulated movie ${name}\n`);
  mkdirSync(join(root, 'gain'));
  writeFileSync(join(root, 'gain/gain.mrc'), smallMrc());
}

function smallMrc() {
  return writeMrc({ nx: 4, ny: 4, data: new Float32Array(16).fill(1) });
}

before(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'nd-compute-hpc-'));
  const outside = join(workDir, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.tiff'), 'outside the root\n');
  rootDir = external ? process.env.COMPUTE_SERVER_HPC_ROOT : join(workDir, 'root');
  assert.ok(rootDir, 'COMPUTE_SERVER_HPC_ROOT must name the server\'s facility data root');
  mkdirSync(rootDir, { recursive: true });
  buildFixture(rootDir, outside);
  if (!external) {
    server = await startReferenceServer({
      token: pairingCode,
      singleOwner: true,
      dataRoots: { [ROOT]: rootDir },
      stageDelayMs: 20,
      maxDownloadBytes: DOWNLOAD_LIMIT,
      localProfile: { cpus: 8, gpus: 0 },
    });
    baseUrl = server.origin;
  }
  if (!externalPairing) {
    pairingServer = await startReferenceServer({ token: pairingModeCode, stageDelayMs: 10 });
    pairingUrl = pairingServer.origin;
  }
  token = (await createComputeClient({ baseUrl }).pair(pairingCode)).token;
});

after(async () => {
  await server?.close();
  await pairingServer?.close();
  rmSync(workDir, { recursive: true, force: true });
});

const api = () => createComputeClient({ baseUrl, token });
const raw = (path, init = {}) => fetch(`${baseUrl}/api/v1/${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
const isInvalid = error => error instanceof ComputeError && error.status === 400 && error.code === 'invalid-spec';
const relion = (project, command, inputs, options = {}) => ({ tool: 'relion', command, project, inputs, options });
const outputNames = job => job.outputs.map(output => output.name);

async function run(client, spec, files = {}, handlers = {}) {
  const receipt = await client.submit(spec, files);
  return client.watch(receipt.id, handlers);
}

async function star(client, id, name) {
  return parseStar(await (await client.output(id, name)).text());
}

function column(block, label) {
  const index = block.columns.indexOf(label);
  assert.ok(index >= 0, `data_${block.name} has ${label}`);
  return block.rows.map(row => row[index]);
}

function blockNamed(blocks, name) {
  const block = blocks.find(item => item.name === name);
  assert.ok(block, `has data_${name}`);
  return block;
}

const importSpec = (project, path = '2026-11/grid3', pattern = '*.tiff') => relion(project, 'import', { movies: { root: ROOT, path, pattern } }, { angpix: 0.885, kV: 200, Cs: 1.4 });

test('info adds ownership, features, roots, profiles, limits and relion in single-owner mode', async () => {
  const anonymous = await createComputeClient({ baseUrl }).info();
  for (const key of ['ownership', 'features', 'dataRoots', 'profiles', 'tools']) assert.equal(anonymous[key], undefined, `${key} needs a token`);
  const info = await api().info();
  assert.equal(info.ownership, 'single');
  assert.ok(info.features.includes('projects'));
  assert.ok(info.features.includes('dataRoots'));
  assert.ok(info.dataRoots.some(root => root.id === ROOT && root.label === ROOT));
  assert.ok(info.profiles.length >= 1);
  assert.ok(info.profiles.every(profile => typeof profile.name === 'string' && typeof profile.summary === 'string'));
  if (!external) {
    assert.deepEqual(info.features, ['projects', 'dataRoots']);
    assert.deepEqual(info.profiles.map(profile => profile.name), ['local']);
  }
  assert.equal(typeof info.limits.maxDownloadBytes, 'number');
  assert.ok(info.limits.maxUploadBytes > 0);
  const tool = info.tools.find(item => item.id === 'relion');
  assert.equal(tool.version, '5.1.1');
  assert.equal(tool.gpuRequired, false);
  assert.match(tool.image, /^vnmd\/relion_5\.1\.1/);
  assert.deepEqual(tool.commands, RELION_COMMANDS);
  assert.ok(info.tools.some(item => item.id === 'nesvor'));
});

test('every pairing maps to one owner and revoking one credential keeps the others', async () => {
  const first = createComputeClient({ baseUrl });
  const second = createComputeClient({ baseUrl });
  assert.equal((await first.pair(pairingCode)).clientId, 'single-owner');
  assert.equal((await second.pair(pairingCode)).clientId, 'single-owner');
  const created = await first.createProject('Shared between credentials');
  assert.ok((await second.projects()).projects.some(project => project.id === created.id));
  assert.equal((await second.project(created.id)).name, 'Shared between credentials');
  await second.disconnect();
  await assert.rejects(createComputeClient({ baseUrl, token: second.token || 'revoked' }).projects(), error => error.status === 401);
  assert.ok((await first.projects()).projects.some(project => project.id === created.id));
  assert.ok((await api().projects()).projects.some(project => project.id === created.id));
  await first.removeProject(created.id);
  await first.disconnect();
  assert.ok((await api().jobs()).jobs);
});

test('single-owner credentials expire after 14 idle days and use refreshes them', async t => {
  if (external) return t.skip('the idle clock is injected only into the reference server');
  let now = Date.UTC(2026, 10, 7);
  const day = 24 * 60 * 60 * 1000;
  const clocked = await startReferenceServer({ singleOwner: true, clock: () => now });
  try {
    const client = createComputeClient({ baseUrl: clocked.origin });
    await client.pair('test-token');
    now += 13 * day;
    await client.projects();
    now += 13 * day;
    await client.projects();
    now += 14 * day + 1;
    await assert.rejects(client.projects(), error => error.status === 401);
    const info = await client.info();
    assert.equal(info.tools, undefined, 'an expired credential reads info as anonymous');
  } finally {
    await clocked.close();
  }
  const pairing = await startReferenceServer({ clock: () => now });
  try {
    const client = createComputeClient({ baseUrl: pairing.origin });
    await client.pair('test-token');
    now += 100 * day;
    assert.deepEqual((await client.jobs()).jobs, [], 'per-pairing credentials do not expire');
  } finally {
    await pairing.close();
  }
});

test('a per-pairing server keeps owners apart and has no projects, roots or relion', async () => {
  const first = createComputeClient({ baseUrl: pairingUrl });
  const second = createComputeClient({ baseUrl: pairingUrl });
  const a = await first.pair(pairingModeCode);
  const b = await second.pair(pairingModeCode);
  assert.notEqual(a.clientId, b.clientId);
  const info = await first.info();
  assert.ok(info.ownership === undefined || info.ownership === 'pairing');
  assert.ok(!info.features?.length);
  assert.equal(info.dataRoots, undefined);
  assert.ok(!info.tools.some(tool => tool.id === 'relion'));
  await assert.rejects(first.projects(), error => error.status === 404);
  await assert.rejects(first.createProject('x'), error => error.status === 404);
  await assert.rejects(first.roots(), error => error.status === 404);
  await assert.rejects(first.entries(ROOT, ''), error => error.status === 404);
  await assert.rejects(first.submit(relion('0'.repeat(32), 'class2d', { particles: 'Extract/job005/particles.star' }), {}), isInvalid);
  const cord = new Blob([syntheticNifti({ value: () => 1 })], { type: 'application/gzip' });
  const receipt = await first.submit({ tool: 'sct', command: 'process_segmentation', cord: 'cord' }, { cord });
  await assert.rejects(second.job(receipt.id), error => error.status === 404);
  assert.ok(!(await second.jobs()).jobs.some(job => job.id === receipt.id));
  const done = await first.watch(receipt.id);
  assert.equal(done.project, null);
  assert.equal(done.directory, null);
  assert.deepEqual(done.dependsOn, []);
  assert.equal(done.scheduler, null);
  assert.ok(done.outputs.every(output => output.download === undefined));
  await first.remove(receipt.id);
  await first.disconnect();
  await second.disconnect();
});

test('v1 tools keep their job shape on a single-owner server', async () => {
  const cord = new Blob([syntheticNifti({ value: () => 1 })], { type: 'application/gzip' });
  const done = await run(api(), { tool: 'sct', command: 'process_segmentation', cord: 'cord' }, { cord });
  assert.deepEqual(outputNames(done), ['morphometry.csv', 'log.txt']);
  assert.ok(done.outputs.every(output => output.download === undefined));
  assert.equal(done.project, null);
  assert.equal(done.directory, null);
  assert.deepEqual(done.dependsOn, []);
  assert.equal(done.scheduler, null);
  await api().remove(done.id);
});

test('roots list one directory level without dotfiles or escaping links', async () => {
  const client = api();
  assert.deepEqual((await client.roots()).roots, [{ id: ROOT, label: ROOT }]);
  const top = await client.entries(ROOT, '');
  assert.equal(top.path, '');
  assert.equal(top.next, null);
  assert.deepEqual(top.entries.map(entry => [entry.name, entry.kind]), [['2026-11', 'directory'], ['gain', 'directory'], ['links', 'directory'], ['paging', 'directory'], ['vanishing', 'directory']]);
  const grid = await client.entries(ROOT, '2026-11/grid3');
  assert.equal(grid.path, '2026-11/grid3');
  assert.deepEqual(grid.entries.map(entry => entry.name), ['FoilHole_1.tiff', 'FoilHole_2.tiff', 'FoilHole_3.tiff', 'notes.txt', 'raw']);
  const movie = grid.entries[0];
  assert.equal(movie.kind, 'file');
  assert.equal(movie.bytes, 'simulated movie 1\n'.length);
  assert.match(movie.modifiedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
  const folder = grid.entries.at(-1);
  assert.equal(folder.kind, 'directory');
  assert.equal(folder.bytes, null);
  const links = await client.entries(ROOT, 'links');
  assert.deepEqual(links.entries.map(entry => [entry.name, entry.kind]), [['inside.tiff', 'file']]);
});

test('listings refuse paths outside the root as not found', async () => {
  const client = api();
  for (const path of ['..', '/etc', '/', '2026-11/../..', '2026-11/..', './2026-11', '2026-11//grid3', '2026-11\\grid3', '2026-11/grid3\0', 'links/escape-dir', 'links/escape.tiff', '2026-11/grid3/FoilHole_1.tiff', 'missing']) {
    await assert.rejects(client.entries(ROOT, path), error => error.status === 404 && error.code === 'not-found', `path ${JSON.stringify(path)}`);
  }
  await assert.rejects(client.entries('nope', ''), error => error.status === 404);
  const response = await raw(`roots/${ROOT}/entries?path=links%2Fescape-dir`);
  assert.equal(response.status, 404);
  assert.doesNotMatch(await response.text(), new RegExp(workDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'a refusal never names a host path');
});

test('listings page at 1000 entries in byte order with an opaque cursor', async () => {
  const client = api();
  const first = await client.entries(ROOT, 'paging');
  assert.equal(first.entries.length, 1000);
  assert.equal(typeof first.next, 'string');
  const second = await client.entries(ROOT, 'paging', first.next);
  assert.equal(second.entries.length, PAGING_FILES - 1000);
  assert.equal(second.next, null);
  const names = [...first.entries, ...second.entries].map(entry => entry.name);
  const expected = Array.from({ length: PAGING_FILES }, (_, index) => `file-${String(index).padStart(4, '0')}.tiff`);
  assert.deepEqual(names, expected);
  await assert.rejects(client.entries(ROOT, 'paging', 'not a cursor'), error => error.status === 404);
});

test('projects are created, listed newest first, read and deleted; active jobs block deletion', async () => {
  const client = api();
  for (const name of ['', 'x'.repeat(101), 'bell\u0007']) {
    await assert.rejects(client.createProject(name), isInvalid, `name ${JSON.stringify(name)}`);
  }
  const older = await client.createProject('Older');
  const newer = await client.createProject('Apoferritin grid 3');
  assert.match(newer.id, /^[0-9a-f]{32}$/);
  assert.equal(newer.name, 'Apoferritin grid 3');
  assert.match(newer.createdAt, /^\d{4}-\d\d-\d\dT/);
  assert.deepEqual(newer.jobs, []);
  const listed = (await client.projects()).projects;
  const ids = listed.map(project => project.id);
  assert.ok(ids.indexOf(newer.id) < ids.indexOf(older.id), 'newest first');
  assert.deepEqual(listed.find(project => project.id === newer.id), { id: newer.id, name: newer.name, createdAt: newer.createdAt, jobCount: 0 });
  const first = await client.submit(importSpec(newer.id), {});
  const second = await client.submit(importSpec(newer.id), {});
  const deletion = await raw(`projects/${newer.id}`, { method: 'DELETE' });
  assert.equal(deletion.status, 409);
  assert.equal((await deletion.json()).error.code, 'conflict');
  const read = await client.project(newer.id);
  assert.deepEqual(read.jobs.map(job => job.directory), ['Import/job001', 'Import/job002']);
  assert.equal((await client.projects()).projects.find(project => project.id === newer.id).jobCount, 2);
  for (const receipt of [first, second]) {
    await client.cancel(receipt.id);
    await client.watch(receipt.id).catch(() => {});
  }
  assert.equal((await raw(`projects/${newer.id}`, { method: 'DELETE' })).status, 204);
  await assert.rejects(client.project(newer.id), error => error.status === 404);
  await assert.rejects(client.job(first.id), error => error.status === 404);
  assert.equal((await raw(`projects/${newer.id}`, { method: 'DELETE' })).status, 404);
  await client.removeProject(older.id);
});

test('import specs that leave the root or match nothing are invalid', async () => {
  const client = api();
  const project = await client.createProject('Escapes');
  const cases = [
    ['..', '*.tiff'],
    ['/etc', '*'],
    ['2026-11/../..', '*'],
    ['2026-11\\grid3', '*.tiff'],
    ['2026-11/grid3\0', '*.tiff'],
    ['2026-11', 'grid3/*.tiff'],
    ['links', '*'],
    ['links', 'escape*'],
    ['links/escape-dir', '*'],
    ['2026-11/grid3', '*.none'],
    ['2026-11/grid3', '.hidden*'],
    ['missing', '*'],
  ];
  for (const [path, pattern] of cases) {
    await assert.rejects(client.submit(importSpec(project.id, path, pattern), {}), isInvalid, `${path} ${pattern}`);
  }
  await assert.rejects(client.submit(relion(project.id, 'import', { movies: { root: 'nope', path: '', pattern: '*' } }, { angpix: 1, kV: 300, Cs: 2.7 }), {}), isInvalid);
  await assert.rejects(client.submit(importSpec('f'.repeat(32)), {}), isInvalid, 'unknown project');
  const inside = await run(client, importSpec(project.id, 'links', 'inside.tiff'));
  const movies = blockNamed(await star(client, inside.id, 'Import/job001/movies.star'), 'movies');
  assert.deepEqual(column(movies, 'rlnMicrographMovieName'), [`/data/${ROOT}/links/inside.tiff`]);
  assert.deepEqual((await client.project(project.id)).jobs.length, 1, 'refused specs allocate no job directory');
  await client.removeProject(project.id);
});

const chain = {};

test('a simulated RELION chain from import to postprocess follows real references', async () => {
  const client = api();
  const project = await client.createProject('Chain');
  chain.project = project.id;
  const p = project.id;
  const idempotencyKey = crypto.randomUUID();
  const receipt = await client.submit(importSpec(p), {}, { idempotencyKey });
  assert.equal((await client.submit(importSpec(p), {}, { idempotencyKey })).id, receipt.id, 'a retried submission returns the same job');
  const imported = await client.watch(receipt.id);
  assert.equal(imported.tool, 'relion');
  assert.equal(imported.project, p);
  assert.equal(imported.directory, 'Import/job001');
  assert.deepEqual(imported.dependsOn, []);
  assert.equal(imported.scheduler, null);
  assert.equal(imported.simulated, true);
  for (const name of ['Import/job001/movies.star', 'Import/job001/RELION_JOB_EXIT_SUCCESS', 'Import/job001/run.out', 'Import/job001/run.err']) assert.ok(outputNames(imported).includes(name), name);
  assert.deepEqual(outputNames(imported), [...outputNames(imported)].sort(), 'outputs sorted by name');
  assert.ok(imported.outputs.every(output => output.download === true || output.bytes > 0));
  const movies = blockNamed(await star(client, imported.id, 'Import/job001/movies.star'), 'movies');
  assert.deepEqual(column(movies, 'rlnMicrographMovieName'), [1, 2, 3].map(index => `/data/${ROOT}/2026-11/grid3/FoilHole_${index}.tiff`));
  assert.match(await (await client.output(imported.id, 'Import/job001/run.out')).text(), /relion_import/);

  const fractions = [];
  const motioncorr = await run(client, relion(p, 'motioncorr', { movies: 'Import/job001/movies.star', gain: { part: 'gain' } }, { dosePerFrame: 1.2 }), { gain: new Blob([smallMrc()]) }, {
    onProgress: event => fractions.push(event.fraction),
  });
  assert.equal(motioncorr.directory, 'MotionCorr/job002');
  assert.deepEqual(motioncorr.dependsOn, [imported.id]);
  assert.ok(fractions.length >= 3);
  assert.ok(fractions.every((value, index) => index === 0 || value >= fractions[index - 1]), 'progress never decreases');
  assert.equal(fractions.at(-1), 1);
  for (const name of ['gain.mrc', 'corrected_micrographs.star', 'Movies/FoilHole_1.mrc', 'Movies/FoilHole_3.star']) assert.ok(outputNames(motioncorr).includes(`MotionCorr/job002/${name}`), name);
  const motionLog = await (await client.output(motioncorr.id, 'MotionCorr/job002/run.out')).text();
  if (!external) assert.match(motionLog, /mpirun --bind-to none -np 2 relion_run_motioncorr_mpi /);
  assert.match(motionLog, /--gainref MotionCorr\/job002\/gain\.mrc/);
  const micrograph = readMrcHeader(Buffer.from(await (await client.output(motioncorr.id, 'MotionCorr/job002/Movies/FoilHole_1.mrc')).arrayBuffer()));
  assert.deepEqual([micrograph.nx, micrograph.ny, micrograph.nz], [64, 64, 1]);

  const ctffind = await run(client, relion(p, 'ctffind', { micrographs: 'MotionCorr/job002/corrected_micrographs.star' }));
  assert.deepEqual(ctffind.dependsOn, [motioncorr.id]);
  const autopick = await run(client, relion(p, 'autopick', { micrographs: 'CtfFind/job003/micrographs_ctf.star' }));
  const extract = await run(client, relion(p, 'extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }));
  assert.equal(extract.directory, 'Extract/job005');
  assert.deepEqual([...extract.dependsOn].sort(), [ctffind.id, autopick.id].sort());
  const particles = blockNamed(await star(client, extract.id, 'Extract/job005/particles.star'), 'particles');
  assert.equal(particles.rows.length, 12);
  assert.ok(column(particles, 'rlnImageName').every(name => /^\d{6}@Extract\/job005\/Movies\/FoilHole_\d\.mrcs$/.test(name)));
  assert.ok(column(particles, 'rlnMicrographName').every(name => /^MotionCorr\/job002\/Movies\/FoilHole_\d\.mrc$/.test(name)));

  const class2d = await run(client, relion(p, 'class2d', { particles: 'Extract/job005/particles.star' }, { nrClasses: 4, nrIterGrad: 20 }));
  for (const suffix of ['data.star', 'model.star', 'optimiser.star', 'classes.mrcs']) assert.ok(outputNames(class2d).includes(`Class2D/job006/run_it020_${suffix}`), suffix);
  const classes = readMrcHeader(Buffer.from(await (await client.output(class2d.id, 'Class2D/job006/run_it020_classes.mrcs')).arrayBuffer()));
  assert.equal(classes.nz, 4);

  const select = await run(client, relion(p, 'select', { particles: 'Class2D/job006/run_it020_data.star' }, { mode: 'classes', classes: [3, 1] }));
  assert.ok(outputNames(select).includes('Select/job007/classes_001_001.star'));
  const selected = blockNamed(await star(client, select.id, 'Select/job007/particles.star'), 'particles');
  assert.equal(selected.rows.length, 6);
  assert.deepEqual([...new Set(column(selected, 'rlnClassNumber'))], ['1', '3']);
  assert.ok(column(selected, 'rlnImageName').every(name => name.includes('@Extract/job005/Movies/')));

  const initialmodel = await run(client, relion(p, 'initialmodel', { particles: 'Select/job007/particles.star' }, { nrIter: 10 }));
  for (const name of ['initial_model.mrc', 'run_it010_model.star', 'run_it010_data.star']) assert.ok(outputNames(initialmodel).includes(`InitialModel/job008/${name}`), name);
  const initialLog = await (await client.output(initialmodel.id, 'InitialModel/job008/run.out')).text();
  assert.match(initialLog, /relion_align_symmetry --i InitialModel\/job008\/run_it010_model\.star/);

  const refine3d = await run(client, relion(p, 'refine3d', { particles: 'Select/job007/particles.star', reference: 'InitialModel/job008/initial_model.mrc' }));
  assert.deepEqual(refine3d.dependsOn, [select.id, initialmodel.id]);
  if (!external) assert.match(await (await client.output(refine3d.id, 'Refine3D/job009/run.out')).text(), /mpirun --bind-to none -np 3 relion_refine_mpi /);
  const maskcreate = await run(client, relion(p, 'maskcreate', { map: 'Refine3D/job009/run_class001.mrc' }));
  const postprocess = await run(client, relion(p, 'postprocess', { halfMap: 'Refine3D/job009/run_half1_class001_unfil.mrc', mask: 'MaskCreate/job010/mask.mrc' }));
  assert.equal(postprocess.directory, 'PostProcess/job011');
  assert.deepEqual(postprocess.dependsOn, [refine3d.id, maskcreate.id]);
  const final = await star(client, postprocess.id, 'PostProcess/job011/postprocess.star');
  const general = blockNamed(final, 'general');
  assert.ok(Number(general.pairs.get('rlnFinalResolution')) > 0);
  assert.equal(general.pairs.get('rlnUnfilteredMapHalf2'), 'Refine3D/job009/run_half2_class001_unfil.mrc');
  assert.ok(blockNamed(final, 'fsc').rows.length > 2);

  const read = await client.project(p);
  assert.deepEqual(read.jobs.map(job => job.directory), [
    'Import/job001', 'MotionCorr/job002', 'CtfFind/job003', 'AutoPick/job004', 'Extract/job005', 'Class2D/job006',
    'Select/job007', 'InitialModel/job008', 'Refine3D/job009', 'MaskCreate/job010', 'PostProcess/job011',
  ]);
  assert.ok(read.jobs.every(job => job.status === 'succeeded' && job.finishedAt));
  assert.deepEqual(read.jobs[10].dependsOn, [refine3d.id, maskcreate.id]);
  Object.assign(chain, { imported, motioncorr, ctffind, autopick, extract, class2d, select, initialmodel, refine3d, maskcreate, postprocess });
});

test('output names with / work in both encodings and stay inside the job directory', async () => {
  const client = api();
  const { postprocess } = chain;
  const name = 'PostProcess/job011/postprocess.star';
  const encoded = await client.output(postprocess.id, name);
  const segments = await raw(`jobs/${postprocess.id}/outputs/${name}`);
  assert.equal(segments.status, 200);
  assert.equal(segments.headers.get('content-disposition'), 'attachment; filename="postprocess.star"');
  assert.match(segments.headers.get('content-type'), /^text\/plain/);
  assert.equal(await segments.text(), await encoded.text());
  for (const escape of ['PostProcess/job011/../../Import/job001/movies.star', 'PostProcess/job011/../job011/postprocess.star', 'Import/job001/movies.star', 'PostProcess/job011/missing.star', '/etc/passwd']) {
    await assert.rejects(client.output(postprocess.id, escape), error => error.status === 404, escape);
  }
  const multi = await raw(`jobs/${postprocess.id}/outputs/PostProcess/job011/..%2F..%2FImport/job001/movies.star`);
  assert.equal(multi.status, 404);
});

test('outputs above the download limit are listed with download false and refused with 413', async t => {
  const client = api();
  const limit = (await client.info()).limits.maxDownloadBytes;
  const { postprocess } = chain;
  for (const output of postprocess.outputs) assert.equal(output.download, output.bytes <= limit, output.name);
  const large = postprocess.outputs.find(output => !output.download);
  if (!large) return t.skip(`no output exceeds the server's ${limit}-byte limit; start it with --max-download-bytes ${DOWNLOAD_LIMIT}`);
  await assert.rejects(client.output(postprocess.id, large.name), error => error.status === 413 && error.code === 'too-large');
  assert.ok(postprocess.outputs.some(output => output.name === 'PostProcess/job011/postprocess.mrc'));
});

test('inputs must be listed outputs of succeeded jobs in the same project', async () => {
  const client = api();
  const p = chain.project;
  await assert.rejects(client.submit(relion(p, 'class2d', { particles: 'Extract/job099/particles.star' }), {}), isInvalid);
  await assert.rejects(client.submit(relion(p, 'class2d', { particles: 'Extract/job005/other_particles.star' }), {}), isInvalid);
  await assert.rejects(client.submit(relion(p, 'class2d', { particles: 'Extract/job005/../job005/particles.star' }), {}), isInvalid);
  await assert.rejects(client.submit(relion(p, 'maskcreate', { map: 'Refine3D/job009/RELION_JOB_EXIT_SUCCESS.mrc' }), {}), isInvalid);
  await assert.rejects(client.submit(relion(p, 'class2d', { particles: 'Extract/job005/particles.star' }, { bogus: 1 }), {}), isInvalid);
  await assert.rejects(client.submit({ ...relion(p, 'class2d', { particles: 'Extract/job005/particles.star' }), profile: 'gpu-99' }, {}), isInvalid);
  await assert.rejects(client.submit(relion(p, 'motioncorr', { movies: 'Import/job001/movies.star', gain: { part: 'gain' } }, { dosePerFrame: 1 }), { gain: new Blob(['not an MRC file']) }), isInvalid);
  await assert.rejects(client.submit(relion(p, 'class2d', { particles: 'Extract/job005/particles.star' }), { mask: new Blob([smallMrc()]) }), isInvalid);
  const other = await client.createProject('Other');
  await assert.rejects(client.submit(relion(other.id, 'class2d', { particles: 'Extract/job005/particles.star' }), {}), isInvalid);
  assert.deepEqual((await client.project(other.id)).jobs, []);
  await client.removeProject(other.id);
  assert.equal((await client.project(p)).jobs.length, 11, 'refused specs allocate no job');
});

test('a job whose STAR files reference a vanished file fails and lists its log', async () => {
  const client = api();
  const project = await client.createProject('Vanishing');
  const p = project.id;
  const imported = await run(client, importSpec(p, 'vanishing', '*.tiff'));
  const motioncorr = await run(client, relion(p, 'motioncorr', { movies: 'Import/job001/movies.star', gain: { root: ROOT, path: 'gain/gain.mrc' } }, { dosePerFrame: 1 }));
  const metadata = blockNamed(await star(client, motioncorr.id, 'MotionCorr/job002/Movies/b.star'), 'general');
  assert.equal(metadata.pairs.get('rlnMicrographGainName'), `/data/${ROOT}/gain/gain.mrc`);
  rmSync(join(rootDir, 'vanishing/b.tiff'));
  const receipt = await client.submit(relion(p, 'ctffind', { micrographs: 'MotionCorr/job002/corrected_micrographs.star' }), {});
  const error = await client.watch(receipt.id).then(() => null, caught => caught);
  assert.ok(error instanceof ComputeError);
  assert.equal(error.code, 'tool-failed');
  assert.match(error.message, new RegExp(`/data/${ROOT}/vanishing/b\\.tiff, which does not exist`));
  const failed = await client.job(receipt.id);
  assert.equal(failed.status, 'failed');
  assert.ok(outputNames(failed).includes('CtfFind/job003/RELION_JOB_EXIT_FAILURE'));
  assert.ok(!outputNames(failed).includes('CtfFind/job003/micrographs_ctf.star'));
  assert.match(await (await client.output(receipt.id, 'CtfFind/job003/run.out')).text(), /ERROR/);
  await assert.rejects(client.submit(relion(p, 'autopick', { micrographs: 'CtfFind/job003/micrographs_ctf.star' }), {}), isInvalid, 'a failed job\'s files are not inputs');
  for (const id of [receipt.id, motioncorr.id, imported.id]) assert.equal((await raw(`jobs/${id}`, { method: 'DELETE' })).status, 204);
  await client.removeProject(p);
});

test('jobs with dependants cannot be deleted; a chain deletes from the newest back', async () => {
  const client = api();
  for (const job of [chain.imported, chain.ctffind, chain.autopick, chain.refine3d]) {
    const response = await raw(`jobs/${job.id}`, { method: 'DELETE' });
    assert.equal(response.status, 409, job.directory);
    assert.equal((await response.json()).error.code, 'conflict');
  }
  assert.equal((await client.project(chain.project)).jobs.length, 11);
  const order = ['postprocess', 'maskcreate', 'refine3d', 'initialmodel', 'select', 'class2d', 'extract', 'autopick', 'ctffind', 'motioncorr', 'imported'];
  for (const key of order) {
    assert.equal((await raw(`jobs/${chain[key].id}`, { method: 'DELETE' })).status, 204, key);
    await assert.rejects(client.output(chain[key].id, `${chain[key].directory}/run.out`), error => error.status === 404);
  }
  assert.deepEqual((await client.project(chain.project)).jobs, []);
  const next = await run(client, importSpec(chain.project));
  assert.equal(next.directory, 'Import/job012', 'job numbers are never reused');
  await client.remove(next.id);
  await client.removeProject(chain.project);
});
