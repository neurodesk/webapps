import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RELION_COMMANDS, RELION_DEFINITION, validateRelionSpec } from '@neurodesk/cryo-em';
import { INPUT_TEXT, OPTION_TEXT, STEPS, classSelectionInputs, defaultInput, finalIterationFirst, inputChoices, parseOption, stepForm, typeLabel } from '../src/steps.js';
import { EXAMPLE_SETTINGS, exampleMovies } from '../src/example.js';
import { APP } from '../src/config.js';

const PROJECT = '0123456789abcdef0123456789abcdef';

test('the steps are every relion command in pipeline order, each option and input with words', () => {
  assert.equal(APP.id, 'cryo-em');
  assert.deepEqual(STEPS.map(step => step.command), [...RELION_COMMANDS]);
  for (const [command, entry] of Object.entries(RELION_DEFINITION.commands)) {
    for (const name of Object.keys(entry.options)) assert.ok(OPTION_TEXT[command]?.[name]?.label, `${command}.${name} has a label`);
    for (const name of Object.keys(entry.inputs)) assert.ok(INPUT_TEXT[command]?.[name]?.label, `${command}.${name} has a label`);
  }
  for (const text of Object.values(OPTION_TEXT).flatMap(Object.values)) assert.ok(text.help.length <= 90, `${text.label}: visible help stays within 90 characters`);
  assert.equal(typeLabel('Class2D'), '2D classification');
});

test('required options come first; options that do not apply are left out', () => {
  const imported = stepForm('import');
  assert.deepEqual(imported.required.map(option => option.name), ['angpix', 'kV', 'Cs']);
  assert.ok(imported.settings.some(option => option.name === 'Q0'));
  const byClasses = stepForm('select', { options: { mode: 'classes' } });
  assert.deepEqual(byClasses.inputs.map(input => input.name), ['particles']);
  assert.ok(byClasses.required.some(option => option.name === 'classes'));
  assert.ok(byClasses.controlling.has('mode'));
  const byRanker = stepForm('select', { options: { mode: 'ranker' } });
  assert.deepEqual(byRanker.inputs.map(input => input.name), ['optimiser']);
  assert.ok(byRanker.settings.some(option => option.name === 'minScore'));
});

test('inputs default to the newest succeeded job of an allowed type, files in its own directory', () => {
  const output = name => ({ name, bytes: 1, contentType: 'text/plain', download: true });
  const jobs = [
    { id: 'a', directory: 'CtfFind/job003', status: 'succeeded', outputs: [output('CtfFind/job003/micrographs_ctf.star')] },
    { id: 'b', directory: 'MotionCorr/job004', status: 'succeeded', outputs: [output('MotionCorr/job004/corrected_micrographs.star'), output('MotionCorr/job004/Movies/m.star')] },
    { id: 'c', directory: 'CtfFind/job005', status: 'failed', outputs: [output('CtfFind/job005/micrographs_ctf.star')] },
  ];
  const { inputs } = stepForm('autopick');
  assert.deepEqual(inputChoices(inputs[0], jobs).map(choice => choice.path), ['MotionCorr/job004/corrected_micrographs.star', 'CtfFind/job003/micrographs_ctf.star']);
  const extract = stepForm('extract').inputs.find(input => input.name === 'micrographs');
  assert.equal(defaultInput(extract, jobs), 'CtfFind/job003/micrographs_ctf.star');
  const mask = stepForm('refine3d').inputs.find(input => input.name === 'mask');
  assert.equal(defaultInput(mask, jobs), undefined, 'an optional input starts empty');
  const half = stepForm('postprocess').inputs.find(input => input.name === 'halfMap');
  const refine = [{ id: 'r', directory: 'Refine3D/job009', status: 'succeeded', outputs: ['run_class001.mrc', 'run_half2_class001_unfil.mrc', 'run_half1_class001_unfil.mrc'].map(name => output(`Refine3D/job009/${name}`)) }];
  assert.equal(defaultInput(half, refine), 'Refine3D/job009/run_half1_class001_unfil.mrc');
});

test('Class2D outputs default to the final iteration; clicked classes take their own iteration\'s files', () => {
  const names = ['000', '025', '100'].flatMap(it => ['classes.mrcs', 'data.star', 'optimiser.star'].map(end => `Class2D/job006/run_it${it}_${end}`));
  const outputs = names.map(name => ({ name }));
  const jobs = [{ id: 'c', status: 'succeeded', directory: 'Class2D/job006', outputs }];
  const select = stepForm('select', { options: { mode: 'classes' } }).inputs[0];
  const ranker = stepForm('select', { options: { mode: 'ranker' } }).inputs[0];
  assert.equal(defaultInput(select, jobs), 'Class2D/job006/run_it100_data.star');
  assert.equal(defaultInput(ranker, jobs), 'Class2D/job006/run_it100_optimiser.star');
  assert.equal([...names].sort(finalIterationFirst).find(name => name.endsWith('_classes.mrcs')), 'Class2D/job006/run_it100_classes.mrcs');
  assert.deepEqual(classSelectionInputs('Class2D/job006/run_it025_classes.mrcs', outputs), {
    particles: 'Class2D/job006/run_it025_data.star',
    optimiser: 'Class2D/job006/run_it025_optimiser.star',
  });
  assert.deepEqual(classSelectionInputs('Class2D/job006/run_it100_classes.mrcs', outputs.filter(output => !output.name.includes('_it100_data'))), {
    optimiser: 'Class2D/job006/run_it100_optimiser.star',
  });
});

test('typed values parse to what the spec validation expects', () => {
  assert.equal(parseOption({ type: 'number' }, ' 0.885 '), 0.885);
  assert.equal(parseOption({ type: 'int' }, ''), undefined);
  assert.deepEqual(parseOption({ type: 'int-list' }, '1, 3 7'), [1, 3, 7]);
  assert.equal(parseOption({ type: 'bool' }, true), true);
  assert.equal(parseOption({ type: 'string' }, 'D2'), 'D2');
});

test('the tutorial settings pass the servers\' validation', () => {
  const sum = 'a'.repeat(64);
  assert.deepEqual(exampleMovies({ 'Movies/b.tiff': sum, 'Movies/a.tiff': sum, 'Movies/gain.mrc': sum, 'Movies/NOTES': sum }), ['a.tiff', 'b.tiff']);
  assert.throws(() => exampleMovies({ 'Movies/a.tiff': sum }), /gain reference/);
  const spec = command => ({ tool: 'relion', command, project: PROJECT, inputs: {}, options: {}, ...EXAMPLE_SETTINGS[command] });
  assert.doesNotThrow(() => validateRelionSpec(spec('import')));
  assert.doesNotThrow(() => validateRelionSpec({ ...spec('motioncorr'), inputs: { ...EXAMPLE_SETTINGS.motioncorr.inputs, movies: 'Import/job001/movies.star' } }));
  for (const command of ['autopick', 'extract', 'class2d', 'initialmodel']) {
    const inputs = Object.fromEntries(stepForm(command).inputs.filter(input => !input.optional).map(input => [input.name, `${input.from[0]}/job001/x${input.suffix}`]));
    assert.doesNotThrow(() => validateRelionSpec({ ...spec(command), inputs }), command);
  }
});
