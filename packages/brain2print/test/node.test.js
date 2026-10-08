import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createFloat32Nifti, extractNiftiHeader, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { readMz3, writeMz3 } from '@neurodesk/webapp-components/file-io/mesh';
import { PARAMETERS, createMesh, meshArgs, meshOptions, orientMesh } from '../src/pipeline.js';
import { ballNifti, createBrainMesh, niimathMesh, parseParameters } from '../src/node.js';
import { flipWinding, inspectMesh } from '../src/mesh.js';

const bin = fileURLToPath(new URL('../bin/brain2print.js', import.meta.url));
const appPackage = JSON.parse(await readFile(new URL('../../../apps/brain2print/package.json', import.meta.url), 'utf8'));
const ownPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const automation = JSON.parse(await readFile(new URL('../../../apps/brain2print/automation.json', import.meta.url), 'utf8'));
const DEFAULTS = { model: 'pve', backend: 'auto', simplify: 20, smooth: 0, largestOnly: true, fillBubbles: true };

const scratch = () => mkdtemp(join(tmpdir(), 'brain2print-test-'));

test('the command line takes exactly the web app create-mesh parameters', () => {
  assert.deepEqual(PARAMETERS, automation.operations['create-mesh'].parameters);
});

test('the command line pins the MindGrab build the web app stages', () => {
  assert.equal(ownPackage.dependencies['@brainchop/mindgrab'], appPackage.dependencies['@brainchop/mindgrab']);
});

test('parameters default like the app and refuse what it refuses', () => {
  assert.deepEqual(parseParameters({}), DEFAULTS);
  assert.deepEqual(parseParameters({ model: 'mindsnap', backend: 'cpu', simplify: '50', smooth: '5', largestOnly: false }), { ...DEFAULTS, model: 'mindsnap', backend: 'cpu', simplify: 50, smooth: 5, largestOnly: false });
  assert.throws(() => parseParameters({ backend: 'webgpu' }), /--backend: .*one of auto, cpu/);
  assert.throws(() => parseParameters({ model: 'mindgrab' }), /--model: .*one of pve, 16chan18cls, mindmap, mindsnap/);
  assert.throws(() => parseParameters({ simplify: '4' }), /--simplify: .*5 to 100/);
  assert.throws(() => parseParameters({ simplify: 'half' }), /--simplify/);
  assert.throws(() => parseParameters({ smooth: '2.5' }), /--smooth/);
  assert.throws(() => parseParameters({ smooth: '21' }), /--smooth: .*0 to 20/);
  assert.throws(() => parseParameters({ isovalue: '0.3' }), /Unknown setting isovalue/);
});

test('mesh options reach niimath as the app fluent call orders them', () => {
  assert.deepEqual(meshArgs(meshOptions(DEFAULTS)), ['-mesh', '-i', '0.5', '-l', '1', '-b', '1', '-r', '0.2', '-s', '0']);
  assert.deepEqual(meshArgs(meshOptions({ ...DEFAULTS, largestOnly: false, fillBubbles: false, simplify: 100, smooth: 5 })), ['-mesh', '-i', '0.5', '-l', '0', '-b', '0', '-r', '1', '-s', '5']);
});

test('niimath meshes both handednesses closed with outward normals', async () => {
  for (const leftHanded of [false, true]) {
    const mesh = await orientMesh(await niimathMesh(ballNifti({ leftHanded }), meshOptions({ ...DEFAULTS, simplify: 100 })));
    assert.equal(mesh.closed, true);
    assert.ok(mesh.measurements.signedVolume > 3500, `${leftHanded ? 'left' : 'right'}-handed ball encloses ${mesh.measurements.signedVolume} mm3`);
  }
});

test('inward-wound niimath output is flipped before it is written', async () => {
  const mz3 = await niimathMesh(ballNifti(), meshOptions(DEFAULTS));
  const { vertices, faces } = await readMz3(mz3);
  flipWinding(faces);
  const mesh = await orientMesh(writeMz3(vertices, faces));
  assert.equal(mesh.measurements.windingCorrected, true);
  assert.ok(mesh.measurements.signedVolume > 0);
  assert.deepEqual(inspectMesh(mesh), { manifold: true, consistent: true, signedVolume: mesh.measurements.signedVolume });
});

test('an open mesh keeps its winding and is reported non-manifold', async () => {
  const { vertices, faces } = await readMz3(await niimathMesh(ballNifti(), meshOptions(DEFAULTS)));
  flipWinding(faces);
  const mesh = await orientMesh(writeMz3(vertices, faces.subarray(3)));
  assert.equal(mesh.closed, false);
  assert.equal(mesh.measurements.windingCorrected, false);
  assert.ok(mesh.measurements.signedVolume < 0);
});

// MindGrab stand-ins: the ball as grey matter plus a constant white-matter fraction, or as labels.
const ballTissues = () => {
  const gm = ballNifti();
  const wm = createFloat32Nifti(new Float32Array(16 ** 3).fill(0.25), extractNiftiHeader(gm));
  return { gm: gm.buffer, wm, csf: wm, brain: wm };
};
const fakeMindgrab = { version: 'test', segment: async () => ({ image: ballNifti().buffer, backend: 'cpu', elapsedMs: 1 }), segmentTissues: async () => ({ tissues: ballTissues(), backend: 'cpu', elapsedMs: 1 }) };

test('the partial-volume model meshes grey plus white matter and names the fraction', async () => {
  const calls = [];
  const mindgrab = { ...fakeMindgrab, segmentTissues: async (input, options) => (calls.push(options), fakeMindgrab.segmentTissues()) };
  const result = await createMesh({ input: new Uint8Array(1), settings: DEFAULTS, mindgrab, mesher: niimathMesh });
  assert.deepEqual(calls, [{ backend: 'auto', model: 'mindmap', gzipOutput: false }]);
  assert.deepEqual(result.files.map(({ role, name }) => [role, name]), [['segmentation', 'brain-fraction.nii'], ['mesh', 'brain2print.stl'], ['geometry', 'brain2print.mz3']]);
  const fraction = readNiftiImageData(result.files[0].bytes.buffer).data;
  assert.deepEqual(new Set(fraction), new Set([0.25, 1.25]));
  assert.deepEqual(result.provenance.segmentation, { model: 'mindmap', partialVolume: true, version: 'test', backend: 'cpu', elapsedMs: 1 });
  assert.deepEqual(result.provenance.meshing, { algorithm: 'niimath mesh', options: { i: 0.5, l: 1, b: 1, r: 0.2, s: 0 } });
});

test('a label model offers its label map and meshes its 0/1 brain mask', async () => {
  // Label 17 throughout the ball: meshing the raw values at 0.5 would cut almost at the background voxels.
  const ball = ballNifti();
  const labels = readNiftiImageData(ball.buffer).data.map((value) => value * 17);
  const image = createFloat32Nifti(labels, extractNiftiHeader(ball));
  const meshed = [];
  const mesher = (surface, options) => (meshed.push(new Set(readNiftiImageData(surface.slice().buffer).data)), niimathMesh(surface, options));
  const mindgrab = { ...fakeMindgrab, segment: async () => ({ image, backend: 'cpu', elapsedMs: 1 }) };
  const result = await createMesh({ input: new Uint8Array(1), settings: { ...DEFAULTS, model: '16chan18cls' }, mindgrab, mesher });
  assert.equal(result.files[0].name, 'segmentation.nii');
  assert.equal(result.files[0].type, 'neuro:label-map');
  assert.deepEqual(new Set(readNiftiImageData(result.files[0].bytes.buffer).data), new Set([0, 17]));
  assert.deepEqual(meshed, [new Set([0, 1])]);
  assert.equal(result.provenance.segmentation.partialVolume, false);
  assert.equal(result.measurements.manifold, true);
});

test('the command line refuses a non-empty output, non-NIfTI input and bad options before segmenting', async () => {
  const directory = await scratch();
  try {
    const input = join(directory, 'brain.nii.gz');
    await writeFile(input, 'not read');
    const occupied = join(directory, 'occupied');
    await writeFile(join(directory, 'keep'), '');
    await assert.rejects(createBrainMesh({ input, output: directory }), /is not empty/);
    await assert.rejects(createBrainMesh({ input: join(directory, 'brain.mgz'), output: occupied }), /is not NIfTI/);
    await assert.rejects(createBrainMesh({ input, output: occupied, parameters: { model: 'mindgrab' } }), /--model/);
    assert.deepEqual((await readdir(directory)).sort(), ['brain.nii.gz', 'keep']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('the executable reports usage errors on stderr with a failing status', () => {
  for (const args of [['only-one.nii'], ['self-check', '--model', 'bogus'], ['download-models', '--smooth', '2'], ['a.nii', 'out', '--simplify', '200'], ['self-check', 'extra'], ['a.nii', 'out', '--cache-dir', 'x']]) {
    const run = spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 1, args.join(' '));
    assert.equal(run.stdout, '');
    assert.notEqual(run.stderr.trim(), '');
  }
  const help = spawnSync(process.execPath, [bin, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  for (const flag of ['--model', '--backend', '--simplify', '--smooth', '--[no-]largest-only', '--[no-]fill-bubbles']) assert.match(help.stdout, new RegExp(flag.replace(/[[\]]/g, '\\$&')));
});
