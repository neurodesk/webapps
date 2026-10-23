import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import createNiimath from '@niivue/niimath/niimath.js';
import mindgrabPackage from '@brainchop/mindgrab/package.json' with { type: 'json' };
import { UsageError, parseMindgrabArgs } from '../src/mindgrab-cli.js';
import { runNiimath } from '../src/niimath.js';
import { MINDGRAB_INPUT, pinnedFile } from '../validation/cases.mjs';

const BIN = fileURLToPath(new URL('../bin/brainchop-mindgrab.js', import.meta.url));

function brainchopMindgrab(args, options = {}) {
  return promisify(execFile)(process.execPath, [BIN, ...args], { maxBuffer: 1 << 26, ...options }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    error => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );
}

test('reads the native argv that meica-rs and fastprep pass', () => {
  assert.deepEqual(parseMindgrabArgs(['/d/ref.nii.gz', '-o', '/d/stripped.nii.gz', '--mask', '/d/mask.nii.gz', '--border', '2']), {
    help: false, input: '/d/ref.nii.gz', output: '/d/stripped.nii.gz', mask: '/d/mask.nii.gz', borderMm: 2, ct: false, comply: false,
  });
  assert.deepEqual(parseMindgrabArgs(['--ct', '--comply', '--output', 'b.nii', '-backend', 'cpu', 'a.nii']), {
    help: false, input: 'a.nii', output: 'b.nii', ct: true, comply: true,
  });
});

test('defaults the output and the mask path as the native command line does', () => {
  const parsed = parseMindgrabArgs(['in.nii', '--mask']);
  assert.equal(parsed.output, 'output.nii.gz');
  assert.equal(parsed.mask, 'mask.nii.gz');
  assert.equal(parseMindgrabArgs(['--mask', '--ct', 'in.nii']).mask, 'mask.nii.gz');
  assert.equal(parseMindgrabArgs(['in.nii']).mask, undefined);
});

test('rejects what the native command line rejects and what the CPU build cannot run', () => {
  for (const [argv, message] of [
    [[], /^no input image given$/],
    [['--mask', 'in.nii'], /^no input image given$/],
    [['a.nii', 'b.nii'], /only one input/],
    [['in.nii', '-o'], /^-o requires a value$/],
    [['in.nii', '--border'], /^--border requires a value$/],
    [['in.nii', '--border', '1.5'], /nonnegative integer/],
    [['in.nii', '--border', '-1'], /nonnegative integer/],
    [['in.nii', '-backend', 'webgpu'], /only the cpu backend/],
    [['in.nii', '--crop'], /--crop is not supported/],
    [['in.nii', '--export-classes'], /--export-classes is not supported/],
    [['in.nii', '-cpu', '4'], /-cpu is not supported/],
    [['in.nii', '--bogus'], /unrecognized argument '--bogus'/],
  ]) {
    assert.throws(() => parseMindgrabArgs(argv), error => error instanceof UsageError && message.test(error.message), argv.join(' '));
  }
});

// The CPU module carries the native parser, so its own --help lists every native option.
async function nativeHelp() {
  const moduleUrl = new URL('dist/brainchop-mindgrab.js', import.meta.resolve('@brainchop/mindgrab/package.json')).href;
  const script = `
    const { default: create } = await import(${JSON.stringify(moduleUrl)});
    const lines = [];
    let exit;
    const exited = new Promise(resolve => { exit = resolve; });
    const module = await create({ noInitialRun: true, thisProgram: 'brainchop-mindgrab', print: line => lines.push(line), printErr: () => {}, onExit: exit });
    try { module.callMain(['--help']); } catch {}
    await exited;
    console.log(lines.join('\\n'));
    process.exit(0);`;
  // A file, not --eval: the module's pthread workers inherit the process's execArgv.
  const dir = await mkdtemp(join(tmpdir(), 'brainchop-mindgrab-'));
  try {
    await writeFile(join(dir, 'help.mjs'), script);
    const { stdout } = await promisify(execFile)(process.execPath, [join(dir, 'help.mjs')]);
    return stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('handles every option the native command line of this MindGrab version accepts', async () => {
  const help = await nativeHelp();
  assert.match(help, /BrainChop mindgrab/);
  const options = new Set(help.split('\n').flatMap(line => line.match(/(?<=^\s*|, )--?[a-z][\w-]*/g) ?? []));
  assert.ok(options.has('--mask') && options.has('--border'), [...options].join(' '));
  for (const option of options) {
    let error;
    try {
      parseMindgrabArgs(['in.nii', option, 'cpu']);
    } catch (thrown) {
      error = thrown;
    }
    assert.doesNotMatch(error?.message ?? '', /unrecognized/, `${option} is new in the native command line; accept or refuse it`);
  }
});

test('--help names MindGrab, its package version and --mask', async () => {
  const { code, stdout } = await brainchopMindgrab(['--help']);
  assert.equal(code, 0);
  assert.match(stdout, new RegExp(`BrainChop mindgrab: .*\\(v${mindgrabPackage.version.replaceAll('.', '\\.')}\\)`));
  assert.match(stdout, /--mask \[PATH\]/);
});

test('a usage error exits 2 before loading MindGrab', async () => {
  const { code, stdout, stderr } = await brainchopMindgrab(['in.nii', '--crop'], { env: { ...process.env, BRAINCHOP_MINDGRAB_PACKAGE: '/nonexistent' } });
  assert.equal(code, 2);
  assert.equal(stdout, '');
  assert.equal(stderr.trim(), 'brainchop: --crop is not supported by the Node CPU build');
});

test('an unreadable input exits 1 with the reason and writes nothing', async () => {
  const missing = await brainchopMindgrab([join(tmpdir(), 'no-such-input.nii.gz')]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /^brainchop: ENOENT/);

  const dir = await mkdtemp(join(tmpdir(), 'brainchop-mindgrab-'));
  try {
    await writeFile(join(dir, 'junk.nii'), new Uint8Array(2048).fill(7));
    const junk = await brainchopMindgrab(['junk.nii', '-o', 'out.nii.gz', '--mask'], { cwd: dir });
    assert.equal(junk.code, 1);
    assert.match(junk.stderr, /unable to read[^]*brainchop: the mindgrab module exited with status 1/);
    assert.deepEqual((await readdir(dir)).sort(), ['junk.nii']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The input grid fields of a NIfTI-1 header: dim, pixdim, and the qform and sform.
const grid = nifti => [...nifti.subarray(40, 56), ...nifti.subarray(76, 108), ...nifti.subarray(252, 344)];
const datatype = nifti => new DataView(nifti.buffer, nifti.byteOffset).getInt16(70, true);

// About a minute and 2.6 GB on eight cores, so it runs with the other MindGrab inference.
const inference = process.env.MINDGRAB_PARITY === '1';
test('writes a binary uint8 mask on the input grid, compressed by name', { skip: !inference && 'set MINDGRAB_PARITY=1 to run MindGrab inference' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'brainchop-mindgrab-'));
  try {
    // An EPI-sized 2 mm grid, so MindGrab must conform the input and resample its mask back.
    const { outputs } = await runNiimath(createNiimath, ['t1.nii.gz', '-subsamp2', 'ref.nii.gz'], {
      inputs: { 't1.nii.gz': await pinnedFile(MINDGRAB_INPUT) },
      outputs: ['ref.nii.gz'],
    });
    await writeFile(join(dir, 'ref.nii.gz'), outputs['ref.nii.gz']);
    const run = await brainchopMindgrab(['ref.nii.gz', '-o', 'stripped.nii', '--mask', 'mask.nii.gz', '--border', '2'], { cwd: dir });
    assert.equal(run.code, 0, run.stderr);

    const input = gunzipSync(outputs['ref.nii.gz']);
    const stripped = await readFile(join(dir, 'stripped.nii'));
    const mask = gunzipSync(await readFile(join(dir, 'mask.nii.gz')));
    assert.deepEqual(grid(stripped), grid(input));
    assert.deepEqual(grid(mask), grid(input));
    assert.equal(datatype(mask), 2, 'uint8');
    const voxels = mask.subarray(new DataView(mask.buffer, mask.byteOffset).getFloat32(108, true));
    assert.equal(voxels.length, (input.length - 352) / 4, 'one byte per float32 input voxel');
    const brain = voxels.filter(v => v === 1).length;
    assert.equal(voxels.filter(v => v > 1).length, 0, 'binary');
    assert.ok(brain > 0.05 * voxels.length && brain < 0.6 * voxels.length, `${brain} of ${voxels.length} voxels are brain`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
