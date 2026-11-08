#!/usr/bin/env node
// Writes test/fixtures/validation-cases.json: specs with what
// validateRelionSpec makes of them (the normalised spec, or the message of the
// first problem), and numbers with relionNumber's text. The Rust server's
// tests read the file and must reach the same decisions with the same
// messages. Run after changing src/commands.json, src/spec.js or this list.

import { writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { relionNumber, validateRelionSpec } from '../src/spec.js';
import { GUI_CASES, PROJECT } from '../test/gui-cases.js';

const spec = (command, inputs, options) => ({ tool: 'relion', command, project: PROJECT, inputs, options });
const importSpec = (movies, options = { angpix: 0.885, kV: 200, Cs: 1.4 }) => spec('import', { movies }, options);
const movies = { root: 'facility', path: '2026-11/grid3', pattern: '*.tiff' };
const motioncorr = (inputs, options = { dosePerFrame: 1.2 }) => spec('motioncorr', { movies: 'Import/job001/movies.star', ...inputs }, options);
const class2d = (particles, options = {}) => spec('class2d', { particles }, options);
const select = (inputs, options) => spec('select', inputs, options);
const refine = { particles: 'Extract/job005/particles.star', reference: 'InitialModel/job008/initial_model.mrc' };

// [name, spec, parts, profile]
const CASES = [
  ['spec is not an object', null],
  ['spec is an array', []],
  ['unknown top-level key', { ...importSpec(movies), extra: 1 }],
  ['tool is not relion', { ...importSpec(movies), tool: 'nesvor' }],
  ['tool is missing', { command: 'import', project: PROJECT, inputs: { movies }, options: {} }],
  ['unknown command', { ...importSpec(movies), command: 'class3d' }],
  ['command is not a string', { ...importSpec(movies), command: 3 }],
  ['project is not hex', { ...importSpec(movies), project: 'X'.repeat(32) }],
  ['project is short', { ...importSpec(movies), project: 'abc' }],
  ['profile is a number', { ...importSpec(movies), profile: 4 }],
  ['profile has a space', { ...importSpec(movies), profile: 'gpu 4' }],
  ['profile is null', { ...importSpec(movies), profile: null }],
  ['profile is named', { ...importSpec(movies), profile: 'gpu-4' }],
  ['options are an array', importSpec(movies, [])],
  ['options are null', importSpec(movies, null)],
  ['options are omitted', { tool: 'relion', command: 'ctffind', project: PROJECT, inputs: { micrographs: 'MotionCorr/job002/corrected_micrographs.star' } }],
  ['unknown option', class2d('Extract/job005/particles.star', { bogus: 1 })],
  ['required option missing', importSpec(movies, { angpix: 0.885, kV: 200 })],
  ['bool option is a string', importSpec(movies, { angpix: 0.885, kV: 200, Cs: 1.4, isMultiframe: 'yes' })],
  ['number option is a string', importSpec(movies, { angpix: '0.885', kV: 200, Cs: 1.4 })],
  ['number option is below its range', importSpec(movies, { angpix: 0.05, kV: 200, Cs: 1.4 })],
  ['number option is above its range', importSpec(movies, { angpix: 0.885, kV: 200, Cs: 11 })],
  ['number option at its inclusive bounds', importSpec(movies, { angpix: 0.1, kV: 500, Cs: 0 })],
  ['int option is fractional', class2d('Extract/job005/particles.star', { nrClasses: 2.5 })],
  ['int option is a boolean', class2d('Extract/job005/particles.star', { nrClasses: true })],
  ['int options set', class2d('Extract/job005/particles.star', { nrClasses: 4, nrIterGrad: 20 })],
  ['int option is null', class2d('Extract/job005/particles.star', { nrClasses: null })],
  ['multipleOf refuses an odd box', spec('extract', { micrographs: 'CtfFind/job003/micrographs_ctf.star', coordinates: 'AutoPick/job004/autopick.star' }, { extractSize: 129 })],
  ['enum option is not listed', spec('refine3d', refine, { sampling: '2 degrees' })],
  ['string option breaks its pattern', spec('refine3d', refine, { sym: 'X5' })],
  ['string option is a number', spec('refine3d', refine, { sym: 1 })],
  ['string option matches its pattern', spec('refine3d', refine, { sym: 'D2', doBlush: true, blushVersion: 'amy-v1.0' })],
  ['mode is required', select({ optimiser: 'Class2D/job006/run_it200_optimiser.star' }, {})],
  ['mode is not listed', select({ optimiser: 'Class2D/job006/run_it200_optimiser.star' }, { mode: 'manual' })],
  ['option applies only in another mode', select({ optimiser: 'Class2D/job006/run_it200_optimiser.star' }, { mode: 'ranker', classes: [1] })],
  ['ranker threshold above 1', select({ optimiser: 'Class2D/job006/run_it200_optimiser.star' }, { mode: 'ranker', minScore: 1.5 })],
  ['classes are required', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes' })],
  ['classes are empty', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [] })],
  ['classes are not a list', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: 3 })],
  ['classes repeat', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [1, 1] })],
  ['class 0', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [0] })],
  ['fractional class', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [1.5] })],
  ['classes out of order', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [3, 1] })],
  ['ranker option in classes mode', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'classes', classes: [1], minScore: 0.5 })],
  ['ranker input missing', select({ particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'ranker' })],
  ['classes input in ranker mode', select({ optimiser: 'Class2D/job006/run_it200_optimiser.star', particles: 'Class2D/job006/run_it200_data.star' }, { mode: 'ranker' })],
  ['inputs are an array', { ...class2d('x'), inputs: [] }],
  ['inputs are omitted', { tool: 'relion', command: 'class2d', project: PROJECT, options: {} }],
  ['unknown input', { ...class2d('Extract/job005/particles.star'), inputs: { particles: 'Extract/job005/particles.star', extra: 'Extract/job005/particles.star' } }],
  ['path has two components', class2d('Extract/particles.star')],
  ['path job component is short', class2d('Extract/job05/particles.star')],
  ['path job component has letters', class2d('Extract/jobabc/particles.star')],
  ['path comes from the wrong job type', class2d('Class2D/job006/particles.star')],
  ['path has the wrong suffix', class2d('Extract/job005/particles.mrc')],
  ['path has a dot-dot component', class2d('Extract/job005/../job005/particles.star')],
  ['path has a dot component', class2d('Extract/./job005/particles.star')],
  ['path is absolute', class2d('/Extract/job005/particles.star')],
  ['path has an empty component', class2d('Extract//job005/particles.star')],
  ['path has a backslash', class2d('Extract/job005\\particles.star')],
  ['path is empty', class2d('')],
  ['path is longer than 1024 bytes', class2d(`Extract/job005/${'a'.repeat(1010)}particles.star`)],
  ['path with a four-digit job and a subdirectory', class2d('Extract/job1234/sub/particles.star', { nrClasses: 2 })],
  ['path is a number', class2d(5)],
  ['half map without half1 or half2', spec('postprocess', { halfMap: 'Refine3D/job009/run_class001_unfil.mrc', mask: 'MaskCreate/job010/mask.mrc' })],
  ['half map and an uploaded mask', spec('postprocess', { halfMap: 'Refine3D/job009/run_half2_class001_unfil.mrc', mask: { part: 'mask' } }), ['mask']],
  ['part with an extra key', motioncorr({ gain: { part: 'gain', root: 'facility' } }), ['gain']],
  ['part names another input', motioncorr({ gain: { part: 'mask' } }), ['mask']],
  ['part was not uploaded', motioncorr({ gain: { part: 'gain' } })],
  ['uploaded part is unused', motioncorr({}), ['gain']],
  ['two uploaded parts, one used', motioncorr({ gain: { part: 'gain' } }), ['gain', 'mask']],
  ['path given where only a part or data file is accepted', motioncorr({ gain: 'Import/job001/gain.mrc' })],
  ['data file with a pattern', motioncorr({ gain: { root: 'facility', path: 'gain', pattern: '*.mrc' } })],
  ['data file with an unknown key', motioncorr({ gain: { root: 'facility', path: 'gain/gain.mrc', label: 'x' } })],
  ['data file with a bad root id', motioncorr({ gain: { root: 'Facility', path: 'gain/gain.mrc' } })],
  ['data file with an empty path', motioncorr({ gain: { root: 'facility', path: '' } })],
  ['data file with a dot-dot path', motioncorr({ gain: { root: 'facility', path: '../gain.mrc' } })],
  ['data file', motioncorr({ gain: { root: 'facility', path: 'gain/gain.mrc' } })],
  ['data root as a string', importSpec('2026-11/grid3/*.tiff')],
  ['data root with an unknown key', importSpec({ ...movies, recursive: true })],
  ['data root id is missing', importSpec({ path: '', pattern: '*' })],
  ['data root id has upper case', importSpec({ ...movies, root: 'Facility' })],
  ['data root path is a number', importSpec({ ...movies, path: 3 })],
  ['data root path is absolute', importSpec({ ...movies, path: '/etc' })],
  ['data root path has a NUL', importSpec({ ...movies, path: '2026-11/grid3\0' })],
  ['data root pattern is missing', importSpec({ root: 'facility', path: '2026-11/grid3' })],
  ['data root pattern is empty', importSpec({ ...movies, pattern: '' })],
  ['data root pattern has a slash', importSpec({ ...movies, pattern: 'grid3/*.tiff' })],
  ['data root pattern has a bracket', importSpec({ ...movies, pattern: '[ab].tiff' })],
  ['data root pattern is longer than 255 bytes', importSpec({ ...movies, pattern: `${'x'.repeat(256)}*` })],
  ['data root pattern of 255 bytes in the root itself', importSpec({ ...movies, path: '', pattern: `${'é'.repeat(127)}*` })],
  ['data root pattern of 256 bytes', importSpec({ ...movies, path: '', pattern: `${'é'.repeat(128)}` })],
  ['rule refuses float16 without power spectra', motioncorr({}, { dosePerFrame: 1, doSavePs: false })],
  ['rule passes without float16', motioncorr({}, { dosePerFrame: 1, doSavePs: false, doFloat16: false })],
  ['refine3d on a two-CPU profile', spec('refine3d', refine), [], { cpus: 2, gpus: 0 }],
  ['refine3d on four GPUs and four CPUs', spec('refine3d', refine), [], { cpus: 4, gpus: 4 }],
  ['refine3d on four GPUs and six CPUs', spec('refine3d', refine), [], { cpus: 6, gpus: 4 }],
  ['class2d without a profile', class2d('Select/job007/particles.star', { nrClasses: 50, particleDiameter: 180, tauFudge: 2.5 })],
];

const NUMBERS = [
  0, -0, 1, -1, 0.1, 0.885, 1.277, 0.02, 1 / 3, 2 / 3, 12.000001, 50000, 123456, 1234567, 0.0001, 0.00001, 0.000123456789,
  1e-30, 3.4e38, 123456.5, 123457.5, 1234565, 1234575, 999999.5, 9999995, 0.125, 2.5, -2.5, 7.5, 1.0000005, 99999.95,
  16777216, 16777217, 1e21, -1000, 0.5, 15, 60, 0.45, 999,
];

export function validationCases() {
  const guiCases = GUI_CASES.map(testCase => [`GUI case: ${testCase.name}`, testCase.spec, testCase.parts ?? [], testCase.profile]);
  const cases = [...CASES, ...guiCases].map(([name, value, parts = [], profile]) => {
    const entry = { name, spec: value, parts };
    if (profile !== undefined) entry.profile = profile;
    try {
      entry.validated = validateRelionSpec(value, { parts, profile });
    } catch (error) {
      entry.error = error.message;
    }
    return entry;
  });
  return {
    cases,
    numbers: NUMBERS.map(value => [value, relionNumber(value)]),
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const target = new URL('../test/fixtures/validation-cases.json', import.meta.url);
  await writeFile(target, `${JSON.stringify(validationCases(), null, 2)}\n`);
  console.log(`Wrote ${fileURLToPath(target)}`);
}
