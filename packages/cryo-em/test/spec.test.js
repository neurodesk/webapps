import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RELION_COMMANDS,
  RELION_DEFINITION,
  classRanges,
  jobTypeDirectory,
  parseRelionLogLine,
  relionCommand,
  relionLaunch,
  relionNumber,
  relionOutputs,
  resolveInputPaths,
  validateRelionSpec,
} from '../src/spec.js';
import { CPU_PROFILE, GPU_PROFILE, GUI_CASES, PROJECT, shellWords } from './gui-cases.js';
import { argvCases } from '../scripts/write-argv-fixture.mjs';

function run(testCase) {
  const validated = validateRelionSpec(testCase.spec, { parts: testCase.parts ?? [], profile: testCase.profile });
  return relionCommand(validated, { directory: testCase.directory, profile: testCase.profile });
}

function commandWords(result) {
  return [[result.program, ...result.args], ...result.then.map(step => [step.program, ...step.args])];
}

test('every command has a GUI case', () => {
  assert.deepEqual(new Set(GUI_CASES.map(testCase => testCase.spec.command)), new Set(RELION_COMMANDS));
  assert.deepEqual(RELION_COMMANDS, ['import', 'motioncorr', 'ctffind', 'autopick', 'extract', 'class2d', 'select', 'initialmodel', 'refine3d', 'maskcreate', 'postprocess']);
});

for (const testCase of GUI_CASES) {
  test(`argv equals the GUI's note.txt: ${testCase.name}`, () => {
    assert.deepEqual(commandWords(run(testCase)), testCase.gui.map(shellWords));
  });
}

test('the note.txt parser keeps quoted, empty and substituted words', () => {
  assert.deepEqual(shellWords('`which relion_refine_mpi` --i "a b"  --gpu ""  --x'), ['relion_refine_mpi', '--i', 'a b', '--gpu', '', '--x']);
});

test('the argv fixture matches the interpreter', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/argv-cases.json', import.meta.url), 'utf8'));
  assert.deepEqual(fixture, argvCases());
});

test('job type directories', () => {
  assert.equal(jobTypeDirectory('class2d'), 'Class2D');
  assert.equal(jobTypeDirectory('postprocess'), 'PostProcess');
  assert.throws(() => jobTypeDirectory('class3d'), /command must be one of/);
});

test('numbers are written as RELION floatToString writes them', () => {
  assert.equal(relionNumber(0.885), '0.885');
  assert.equal(relionNumber(1.277), '1.277');
  assert.equal(relionNumber(0.02), '0.02');
  assert.equal(relionNumber(0), '0');
  assert.equal(relionNumber(-0), '0');
  assert.equal(relionNumber(-1), '-1');
  assert.equal(relionNumber(50000), '50000');
  assert.equal(relionNumber(123456), '123456');
  assert.equal(relionNumber(1234567), '1.23457e+06');
  assert.equal(relionNumber(0.0001), '0.0001');
  assert.equal(relionNumber(0.00001), '1e-05');
  assert.equal(relionNumber(1 / 3), '0.333333');
  assert.equal(relionNumber(12.000001), '12');
});

test('launch rules', () => {
  assert.deepEqual(relionLaunch('refine3d', { cpus: 24, gpus: 4 }), { mpiRanks: 5, threads: 4, gpus: 4 });
  assert.deepEqual(relionLaunch('refine3d', { cpus: 24, gpus: 2 }), { mpiRanks: 3, threads: 8, gpus: 2 });
  assert.deepEqual(relionLaunch('refine3d', { cpus: 32, gpus: 8 }), { mpiRanks: 9, threads: 3, gpus: 8 });
  assert.deepEqual(relionLaunch('refine3d', { cpus: 3, gpus: 0 }), { mpiRanks: 3, threads: 1, gpus: 0 });
  assert.throws(() => relionLaunch('refine3d', { cpus: 2, gpus: 0 }), /needs 3 MPI ranks/);
  assert.throws(() => relionLaunch('refine3d', { cpus: 4, gpus: 4 }), /needs 5 MPI ranks/);
  assert.deepEqual(relionLaunch('class2d', { cpus: 24, gpus: 4 }), { mpiRanks: 1, threads: 24, gpus: 4 });
  assert.deepEqual(relionLaunch('initialmodel', { cpus: 8, gpus: 1 }), { mpiRanks: 1, threads: 8, gpus: 1 });
  assert.deepEqual(relionLaunch('motioncorr', { cpus: 16, gpus: 4 }), { mpiRanks: 4, threads: 4, gpus: 0 });
  assert.deepEqual(relionLaunch('motioncorr', { cpus: 3, gpus: 0 }), { mpiRanks: 1, threads: 3, gpus: 0 });
  assert.deepEqual(relionLaunch('ctffind', { cpus: 16, gpus: 0 }), { mpiRanks: 16, threads: 1, gpus: 0 });
  assert.deepEqual(relionLaunch('autopick', { cpus: 1, gpus: 0 }), { mpiRanks: 1, threads: 1, gpus: 0 });
  assert.deepEqual(relionLaunch('maskcreate', { cpus: 16, gpus: 0 }), { mpiRanks: 1, threads: 16, gpus: 0 });
  assert.deepEqual(relionLaunch('postprocess', { cpus: 16, gpus: 4 }), { mpiRanks: 1, threads: 1, gpus: 0 });
  for (const command of RELION_COMMANDS) {
    for (const profile of [{ cpus: 64, gpus: 8 }, { cpus: 12, gpus: 0 }, { cpus: 7, gpus: 1 }]) {
      const { mpiRanks, threads } = relionLaunch(command, profile);
      assert.ok(mpiRanks * threads <= profile.cpus, `${command} fits ${JSON.stringify(profile)}`);
      if (command === 'refine3d') assert.equal(mpiRanks % 2, 1);
    }
  }
  assert.throws(() => relionLaunch('class2d', { cpus: 0, gpus: 0 }), /profile.cpus/);
  assert.throws(() => relionLaunch('class2d', { cpus: 4 }), /profile.gpus/);
});

test('MPI programs carry _mpi only with more than one rank', () => {
  const testCase = GUI_CASES.find(item => item.spec.command === 'ctffind');
  const single = run({ ...testCase, profile: { cpus: 1, gpus: 0 } });
  assert.equal(single.program, 'relion_run_ctffind');
  assert.equal(single.mpiRanks, 1);
  const many = run(testCase);
  assert.equal(many.program, 'relion_run_ctffind_mpi');
  assert.equal(many.mpiRanks, 16);
});

test('class2d and initialmodel never use MPI', () => {
  for (const command of ['class2d', 'initialmodel']) {
    const testCase = GUI_CASES.find(item => item.spec.command === command);
    const result = run({ ...testCase, profile: { cpus: 128, gpus: 8 } });
    assert.equal(result.mpiRanks, 1);
    assert.equal(result.program, 'relion_refine');
    assert.deepEqual(result.args.slice(result.args.indexOf('--j'), result.args.indexOf('--j') + 4), ['--j', '128', '--gpu', '']);
  }
});

test('--gpu "" is written only when the profile has GPUs', () => {
  const testCase = GUI_CASES.find(item => item.spec.command === 'refine3d');
  assert.ok(run(testCase).args.includes('--gpu'));
  const cpu = run({ ...testCase, profile: CPU_PROFILE });
  assert.ok(!cpu.args.includes('--gpu'));
  assert.equal(cpu.mpiRanks, 3);
  assert.equal(cpu.args[cpu.args.indexOf('--j') + 1], '5');
});

test('a refine3d spec is refused for a profile without three ranks', () => {
  const testCase = GUI_CASES.find(item => item.spec.command === 'refine3d');
  assert.throws(() => validateRelionSpec(testCase.spec, { profile: { cpus: 2, gpus: 0 } }), /needs 3 MPI ranks/);
});

function base(command) {
  const testCase = GUI_CASES.find(item => item.spec.command === command);
  return structuredClone(testCase.spec);
}

test('validation rejects malformed specs', () => {
  const cases = [
    [null, /spec must be an object/],
    [{ ...base('class2d'), extra: 1 }, /unknown key extra/],
    [{ ...base('class2d'), tool: 'nesvor' }, /tool must be "relion"/],
    [{ ...base('class2d'), command: 'class3d' }, /command must be one of/],
    [{ ...base('class2d'), project: 'ABC' }, /project must be a project id/],
    [{ ...base('class2d'), profile: '../x' }, /profile must be a profile name/],
    [{ ...base('class2d'), options: [] }, /options must be an object/],
    [{ ...base('class2d'), options: { nrIterations: 10 } }, /unknown option nrIterations/],
    [{ ...base('class2d'), options: { nrClasses: 0 } }, /nrClasses must be in \[1, 400\]/],
    [{ ...base('class2d'), options: { nrClasses: 2.5 } }, /nrClasses must be an integer/],
    [{ ...base('class2d'), options: { tauFudge: '2' } }, /tauFudge must be a finite number/],
    [{ ...base('class2d'), options: { tauFudge: Infinity } }, /tauFudge must be a finite number/],
    [{ ...base('class2d'), options: { doCenter: 'yes' } }, /doCenter must be a boolean/],
    [{ ...base('extract'), options: { extractSize: 129 } }, /extractSize must be a multiple of 2/],
    [{ ...base('refine3d'), options: { sampling: '7.5' } }, /sampling must be one of/],
    [{ ...base('refine3d'), options: { sym: 'C1; rm -rf /' } }, /sym must match/],
    [{ ...base('import'), options: { angpix: 0.885, kV: 200 } }, /option Cs is required/],
    [{ ...base('motioncorr'), options: {} }, /option dosePerFrame is required/],
    [{ ...base('motioncorr'), options: { dosePerFrame: 1, doSavePs: false } }, /doFloat16 needs doSavePs/],
    [{ ...base('class2d'), inputs: {} }, /input particles is required/],
    [{ ...base('class2d'), inputs: { particles: 'Extract/job005/particles.star', mask: 'x' } }, /unknown input mask/],
    [{ ...base('class2d'), inputs: [] }, /inputs must be an object/],
  ];
  for (const [spec, message] of cases) assert.throws(() => validateRelionSpec(spec), message, JSON.stringify(spec));
});

test('select options and inputs follow the mode', () => {
  const ranker = base('select');
  assert.throws(() => validateRelionSpec({ ...ranker, options: {} }), /option mode is required/);
  assert.throws(() => validateRelionSpec({ ...ranker, options: { mode: 'manual' } }), /mode must be one of classes, ranker/);
  assert.throws(() => validateRelionSpec({ ...ranker, options: { mode: 'ranker', classes: [1] } }), /option classes applies only when mode is "classes"/);
  assert.throws(() => validateRelionSpec({ ...ranker, options: { mode: 'ranker', minScore: 1.5 } }), /minScore must be in \[0, 1\]/);
  const classes = { ...ranker, inputs: { particles: 'Class2D/job006/run_it200_data.star' } };
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'classes' } }), /option classes is required/);
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'classes', classes: [] } }), /classes must list 1 to 1000 integers/);
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'classes', classes: [1, 1] } }), /classes lists 1 twice/);
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'classes', classes: [0] } }), /classes item must be in \[1, 1000\]/);
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'classes', classes: [1.5] } }), /classes item must be an integer/);
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'classes', classes: [1], minScore: 0.5 } }), /option minScore applies only when mode is "ranker"/);
  assert.throws(() => validateRelionSpec({ ...classes, options: { mode: 'ranker' } }), /input optimiser is required/);
  const both = { optimiser: 'Class2D/job006/run_it200_optimiser.star', particles: 'Class2D/job006/run_it200_data.star' };
  assert.throws(() => validateRelionSpec({ ...classes, inputs: both, options: { mode: 'ranker' } }), /input particles applies only when mode is "classes"/);
  const validated = validateRelionSpec({ ...classes, options: { mode: 'classes', classes: [2] } });
  assert.deepEqual(validated.options, { mode: 'classes', classes: [2] });
});

test('class ranges join consecutive classes', () => {
  assert.deepEqual(classRanges([5, 3, 4]), [[3, 5]]);
  assert.deepEqual(classRanges([12, 1, 7, 2, 8]), [[1, 2], [7, 8], [12, 12]]);
});

test('earlier-job inputs are project-relative paths of the right job type', () => {
  const spec = base('class2d');
  const bad = [
    ['/project/Extract/job005/particles.star', /relative path/],
    ['Extract/job005//particles.star', /relative path/],
    ['Extract/job005/../job004/particles.star', /relative path/],
    ['./Extract/job005/particles.star', /relative path/],
    ['Extract\\job005\\particles.star', /backslash/],
    ['Extract/job005/particles\0.star', /NUL/],
    ['', /must not be empty/],
    [`Extract/job005/${'a'.repeat(1020)}particles.star`, /longer than 1024 bytes/],
    ['particles.star', /<Type>\/jobNNN\/<file>/],
    ['Extract/job5/particles.star', /<Type>\/jobNNN\/<file>/],
    ['Extract/job005', /<Type>\/jobNNN\/<file>/],
    ['AutoPick/job004/particles.star', /output of a Extract or Select job/],
    ['Extract/job005/particles.mrcs', /must end with particles.star/],
    [42, /must be a project-relative path/],
  ];
  for (const [path, message] of bad) {
    assert.throws(() => validateRelionSpec({ ...spec, inputs: { particles: path } }), message, String(path));
  }
  assert.equal(validateRelionSpec({ ...spec, inputs: { particles: 'Extract/job1234/particles.star' } }).inputs.particles, 'Extract/job1234/particles.star');
  const post = base('postprocess');
  assert.throws(() => validateRelionSpec({ ...post, inputs: { ...post.inputs, halfMap: 'Refine3D/job009/run_class001_unfil.mrc' } }), /must contain half\[12\]/);
});

test('data-root references follow the protocol rules', () => {
  const spec = base('import');
  const movies = spec.inputs.movies;
  const bad = [
    [{ ...movies, root: 'Facility' }, /root must be a data root id/],
    [{ ...movies, path: '../secret' }, /relative path/],
    [{ ...movies, path: '/scratch' }, /relative path/],
    [{ ...movies, pattern: 'Movies/*.tiff' }, /only \* and \?/],
    [{ ...movies, pattern: '[ab].tiff' }, /only \* and \?/],
    [{ ...movies, pattern: '' }, /non-empty string/],
    [{ ...movies, pattern: 'x'.repeat(256) }, /longer than 255 bytes/],
    [{ ...movies, extra: 1 }, /unknown key extra/],
    ['Import/job001/movies.star', /must be \{ root, path, pattern \}/],
  ];
  for (const [value, message] of bad) {
    assert.throws(() => validateRelionSpec({ ...spec, inputs: { movies: value } }), message, JSON.stringify(value));
  }
});

test('uploaded parts must be named after their input and used', () => {
  const spec = base('motioncorr');
  assert.throws(() => validateRelionSpec({ ...spec, inputs: { ...spec.inputs, gain: { part: 'gain' } } }), /must name an uploaded part/);
  assert.throws(() => validateRelionSpec({ ...spec, inputs: { ...spec.inputs, gain: { part: 'mask' } } }, { parts: ['mask'] }), /inputs.gain.part must be "gain"/);
  assert.throws(() => validateRelionSpec({ ...spec, inputs: { ...spec.inputs, gain: 'Import/job001/gain.mrc' } }), /must be \{ "part": "gain" \}/);
  assert.throws(() => validateRelionSpec(spec, { parts: ['gain'] }), /uploaded part gain is not used/);
  const refine = base('refine3d');
  const withPath = validateRelionSpec({ ...refine, inputs: { ...refine.inputs, mask: 'MaskCreate/job010/mask.mrc' } });
  assert.equal(withPath.inputs.mask, 'MaskCreate/job010/mask.mrc');
});

test('the job directory must match the command', () => {
  const testCase = GUI_CASES.find(item => item.spec.command === 'class2d');
  for (const directory of ['Class2D/job006/', 'Refine3D/job006', 'Class2D/job6', '../Class2D/job006', undefined]) {
    assert.throws(() => run({ ...testCase, directory }), /directory must be Class2D\/jobNNN/, String(directory));
  }
});

test('the server can pass its own input paths', () => {
  const testCase = GUI_CASES.find(item => item.spec.command === 'import');
  const validated = validateRelionSpec(testCase.spec);
  const result = relionCommand(validated, { directory: 'Import/job001', profile: CPU_PROFILE, inputPaths: { movies: '/data/examples/x/*.tiff' } });
  assert.equal(result.args[result.args.indexOf('--i') + 1], '/data/examples/x/*.tiff');
});

test('outputs follow the options', () => {
  const outputs = command => relionOutputs(validateRelionSpec(GUI_CASES.find(item => item.spec.command === command).spec));
  assert.deepEqual(outputs('class2d').map(item => item.path), ['run_it200_data.star', 'run_it200_optimiser.star', 'run_it200_model.star', 'run_it200_classes.mrcs']);
  assert.deepEqual(outputs('import'), [{ path: 'movies.star', required: true }]);
  assert.deepEqual(outputs('select').map(item => item.path), ['particles.star', 'class_averages.star', 'rank_optimiser.star']);
  const classes = validateRelionSpec({ ...base('select'), inputs: { particles: 'Class2D/job006/run_it200_data.star' }, options: { mode: 'classes', classes: [1] } });
  assert.deepEqual(relionOutputs(classes), [{ path: 'particles.star', required: true }]);
  const longer = validateRelionSpec({ ...base('initialmodel'), options: { nrIter: 50 } });
  assert.ok(relionOutputs(longer).some(item => item.path === 'run_it050_model.star'));
  for (const command of RELION_COMMANDS) {
    assert.ok(RELION_DEFINITION.commands[command].outputs.some(item => item.required), command);
  }
});

test('log lines: levels and progress', () => {
  const spec = command => validateRelionSpec(GUI_CASES.find(item => item.spec.command === command).spec);
  assert.deepEqual(parseRelionLogLine(spec('class2d'), ' Gradient optimisation iteration 51 of 200 (Step size 0.3)'), { level: 'info', progress: [0.25, '2D classification: iteration 51 of 200'] });
  assert.deepEqual(parseRelionLogLine(spec('initialmodel'), ' Gradient optimisation iteration 1 of 100 with 2000 particles (Step size 0.5)'), { level: 'info', progress: [0, 'Initial model: iteration 1 of 100'] });
  assert.deepEqual(parseRelionLogLine(spec('refine3d'), ' Auto-refine: Iteration= 5'), { level: 'info', progress: [0.2, '3D refinement: iteration 5'] });
  assert.deepEqual(parseRelionLogLine(spec('refine3d'), ' Auto-refine: Iteration= 40'), { level: 'info', progress: [0.9, '3D refinement: iteration 40'] });
  assert.deepEqual(parseRelionLogLine(spec('refine3d'), ' Auto-refine: Refinement has converged, entering last iteration where two halves will be combined...'), { level: 'info', progress: [0.9, '3D refinement: final iteration'] });
  const bar = `000/??? sec ~~(,_,">                                                      [oo]\r   3/  10 sec ${'.'.repeat(18)}~~(,_,">                                          [oo]\r   6/  10 sec ${'.'.repeat(36)}~~(,_,">                        [oo]`;
  assert.deepEqual(parseRelionLogLine(spec('ctffind'), bar), { level: 'info', progress: [0.6, 'CTF estimation'] });
  assert.deepEqual(parseRelionLogLine(spec('motioncorr'), ` 1.50/3.00 min ${'.'.repeat(60)}~~(,_,"> yum!`), { level: 'info', progress: [1, 'Motion correction'] });
  assert.deepEqual(parseRelionLogLine(spec('class2d'), `   6/  10 sec ${'.'.repeat(36)}~~(,_,">`), { level: 'info', progress: null });
  assert.deepEqual(parseRelionLogLine(spec('postprocess'), '  + FINAL RESOLUTION: 3.1'), { level: 'info', progress: null });
  assert.deepEqual(parseRelionLogLine(spec('extract'), 'ERROR: cannot read file'), { level: 'error', progress: null });
  assert.deepEqual(parseRelionLogLine(spec('refine3d'), ' Auto-refine: WARNING: Iter = 3 The angular accuracy is worse than 10 degrees'), { level: 'warning', progress: null });
  assert.deepEqual(parseRelionLogLine(spec('autopick'), ' Warning! no particles picked'), { level: 'warning', progress: null });
});

test('every definition entry is well formed', () => {
  const types = new Set(['bool', 'int', 'number', 'enum', 'string', 'int-list']);
  for (const [command, entry] of Object.entries(RELION_DEFINITION.commands)) {
    for (const [name, option] of Object.entries(entry.options)) {
      assert.ok(types.has(option.type), `${command}.${name} type`);
      assert.ok(option.required === true || 'default' in option, `${command}.${name} default or required`);
      assert.ok(!(option.required && 'default' in option), `${command}.${name} has both default and required`);
      if (option.type === 'int' || option.type === 'number') {
        assert.ok(option.min <= option.max, `${command}.${name} range`);
        if ('default' in option) assert.ok(option.default >= option.min && option.default <= option.max, `${command}.${name} default in range`);
      }
      if (option.type === 'enum' && 'default' in option) assert.ok(option.enum.includes(option.default), `${command}.${name} default in enum`);
      if (option.type === 'string') assert.match(option.default, new RegExp(option.pattern), `${command}.${name} default`);
    }
    if (entry.launch.rule !== 'single') assert.equal(entry.steps[0].mpi, true, `${command} first step is MPI`);
  }
  assert.equal(PROJECT.length, 32);
  assert.equal(GPU_PROFILE.gpus, 4);
});

test('a gain reference can be a file in a data root', () => {
  const spec = {
    tool: 'relion',
    command: 'motioncorr',
    project: 'a'.repeat(32),
    inputs: { movies: 'Import/job001/movies.star', gain: { root: 'examples', path: 'relion-tutorial/Movies/gain.mrc' } },
    options: { dosePerFrame: 1.277 },
  };
  const validated = validateRelionSpec(spec, { parts: [] });
  assert.equal(resolveInputPaths(validated, 'MotionCorr/job002').gain, '/data/examples/relion-tutorial/Movies/gain.mrc');
  for (const gain of [{ root: 'examples', path: '../gain.mrc' }, { root: 'examples', path: '' }, { root: 'examples', path: 'gain.mrc', extra: 1 }]) {
    assert.throws(() => validateRelionSpec({ ...spec, inputs: { ...spec.inputs, gain } }, { parts: [] }));
  }
});
