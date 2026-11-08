// A complete source recording is a prerequisite for comparing the port.
// This checks coverage, saved classes, array integrity and ROI reconstruction.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function validateRecording(directory, { smoke = false } = {}) {
  const read = name => JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
  const reference = read('reference.json');
  assert.equal(reference.smoke, smoke, 'Smoke and full recordings must be validated separately');
  const environment = read('environment.json');
  let execution = 'MATLAB source';
  if (smoke && environment.smokeInterpreter === 'Octave') {
    execution = 'Octave plumbing smoke';
    assert.ok(environment.version);
  } else {
    assert.equal(environment.executionMode, 'source-reverse-correlation-matrix');
    assert.match(environment.matlab, /^23\.2\.0\.3097123/);
  }
  const byId = new Map(reference.cases.map(item => [item.id, item]));
  assert.equal(byId.size, reference.cases.length, 'Duplicate case IDs');
  const expected = [];
  for (const precision of smoke ? ['single'] : ['double', 'single']) {
    for (const [dataset, averages] of smoke ? [['x001_lh', [1]]] : [['x001_lh', [1, 0]], ['x001_rh', [1]]]) {
      for (const average of averages) {
        const id = `revcor_${precision}_${dataset}_average${average}`;
        expected.push(id, `${id}_template`);
        for (const global of [0, 1]) {
          for (const smooth of [0, 1]) {
            for (const mode of [0, -1, 1]) expected.push(`${id}_cf_mode${mode}_smooth${smooth}_global${global}`);
          }
        }
        for (const mode of ['hull', 'custom_hrf', 'gaussian']) expected.push(`${id}_rc_${mode}`);
      }
    }
  }
  assert.deepEqual([...byId.keys()].sort(), expected.sort(), 'Incomplete RC/CF matrix');
  const hashes = {};
  const informativeVertices = {};
  function array(descriptor) {
    assert.ok(descriptor && Array.isArray(descriptor.shape), 'Missing array descriptor');
    assert.ok(descriptor.shape.every(n => Number.isSafeInteger(n) && n >= 0));
    assert.equal(path.basename(descriptor.file), descriptor.file, 'Arrays must be in the recording root');
    const bytes = fs.readFileSync(path.join(directory, descriptor.file));
    const count = descriptor.shape.reduce((a, b) => a * b, 1);
    assert.equal(bytes.length, count * 8, `Wrong size: ${descriptor.file}`);
    hashes[descriptor.file] = createHash('sha256').update(bytes).digest('hex');
    assert.equal(descriptor.imaginary, '', `Unexpected complex RC/CF array: ${descriptor.file}`);
    return Array.from({ length: count }, (_, i) => bytes.readDoubleLE(i * 8));
  }
  function arrays(value) {
    if (!value || typeof value !== 'object') return;
    if ('file' in value && 'shape' in value) array(value);
    else for (const child of Object.values(value)) arrays(child);
  }
  for (const item of reference.cases) arrays(item);
  for (const item of reference.cases) {
    if (item.kind === 'preprocess') {
      assert.equal(item.courses.class, item.precision);
      continue;
    }
    if (item.kind === 'benson') {
      assert.equal(item.maps.class, item.precision);
      continue;
    }
    assert.equal(item.kind, 'pipeline');
    const preprocessing = byId.get(item.preprocessing);
    assert.ok(preprocessing, `Missing preprocessing: ${item.id}`);
    const [volumes, vertices] = preprocessing.courses.shape;
    const seeds = array(preprocessing.seedVertices);
    const selected = array(item.savedVertices);
    assert.deepEqual(selected, array(preprocessing.roi), `ROI changed: ${item.id}`);
    assert.ok(vertices >= 26);
    assert.ok(seeds.every(v => Number.isInteger(v) && v >= 1 && v <= vertices));
    assert.equal(new Set(seeds).size, seeds.length);
    assert.ok(seeds.some(v => selected.includes(v)) && seeds.some(v => !selected.includes(v)), 'Seed/ROI must overlap only partly');
    const cfNames = {
      0: ['R^2', 'x0', 'y0', 'Centre', 'Surround', 'Beta', 'Suppression', 'Fwhm', 'Vx'],
      '-1': ['R^2', 'x0', 'y0', 'Sigma', 'Fwhm', 'Vx'],
      1: ['R^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline', 'Fwhm', 'Vx'],
    };
    const labels = item.analysis === 'cf' ? cfNames[item.model.Fit_pRF]
      : typeof item.model.Prf_Function === 'string' ? ['R^2', 'x0', 'y0', 'Sigma', 'Beta', 'Baseline']
        : ['R^2', 'x0', 'y0', 'Fwhm', 'Beta'];
    assert.ok(labels, 'Unknown parameter estimator');
    assert.deepEqual(item.values, [...labels, ...(preprocessing.noiseCeiling ? ['Noise Ceiling'] : [])], `Wrong map labels: ${item.id}`);
    assert.equal(item.model.Save_Rmaps, true);
    assert.deepEqual(item.mapReplayModel, { ...item.model, Save_Rmaps: false, Data_Precision: item.precision }, 'Map replay may change storage and precision selection only');
    assert.equal(item.savedMaps.class, item.precision);
    assert.equal(item.savedCourses.class, item.precision);
    assert.equal(item.profiles.class, item.precision);
    assert.deepEqual(item.savedCourses.shape, [volumes, selected.length]);
    assert.deepEqual(item.maps.shape, [item.values.length, vertices]);
    assert.deepEqual(item.savedMaps.shape, [item.values.length, selected.length]);
    const savedMaps = array(item.savedMaps);
    const maps = array(item.maps);
    informativeVertices[item.id] = selected.filter((_, i) => Number.isFinite(savedMaps[i * item.values.length]) && savedMaps[i * item.values.length] !== 0).length;
    assert.ok(informativeVertices[item.id] > 0, `No finite nonzero R^2 in ${item.id}`);
    const positions = new Map(selected.map((vertex, i) => [vertex - 1, i]));
    for (let vertex = 0; vertex < vertices; vertex++) {
      for (let row = 0; row < item.values.length; row++) {
        const i = positions.get(vertex);
        const value = i === undefined ? 0 : savedMaps[i * item.values.length + row];
        assert.ok(Object.is(maps[vertex * item.values.length + row], value) || maps[vertex * item.values.length + row] === value,
          `Expanded map differs at ${item.id}, vertex ${vertex}, row ${row}`);
      }
    }
    if (item.analysis === 'cf') {
      assert.ok(byId.has(item.template), 'Missing template');
      assert.equal(item.globalSignal.class, item.precision);
      assert.equal(item.seedCourses.class, item.precision);
      // Upstream's all-elements NaN guard leaves ConFlds uncompressed whenever
      // the ROI excludes vertices, even though Data and Y are compressed.
      assert.deepEqual(item.profiles.shape, [seeds.length, vertices]);
      const profiles = array(item.profiles);
      for (let vertex = 0; vertex < vertices; vertex++) {
        const profile = profiles.slice(vertex * seeds.length, (vertex + 1) * seeds.length);
        if (!positions.has(vertex)) assert.ok(profile.every(Number.isNaN));
        else assert.ok(profile.every(Number.isFinite), `Nonfinite inside-ROI profile: ${item.id}, vertex ${vertex}`);
      }
      assert.deepEqual(item.seedCourses.shape, [volumes, seeds.length]);
      assert.deepEqual(item.recomputedCorrectedCourses.shape, [volumes, vertices]);
      const corrected = array(item.recomputedCorrectedCourses);
      const savedCourses = array(item.savedCourses);
      for (let i = 0; i < selected.length; i++) {
        for (let t = 0; t < volumes; t++) {
          assert.equal(savedCourses[i * volumes + t], corrected[(selected[i] - 1) * volumes + t],
            `Global regression replay differs: ${item.id}, vertex ${selected[i]}, volume ${t}`);
        }
      }
    } else {
      assert.equal(item.analysis, 'revcor');
      assert.equal(item.regressors.class, 'double', 'Use the actual pre-compression regressors');
      assert.equal(item.savedRegressors.class, item.precision);
      assert.equal(item.rawMaps.class, item.precision);
      assert.deepEqual(item.apertures.shape, [item.model.Rdim, item.model.Rdim, volumes]);
      assert.deepEqual(item.profiles.shape, [item.model.Rdim ** 2, selected.length]);
      assert.deepEqual(item.regressors.shape, [volumes, item.model.Rdim ** 2]);
      const profiles = array(item.profiles);
      assert.ok(profiles.every(Number.isFinite), `Nonfinite RC profile: ${item.id}`);
      assert.ok(profiles.some(v => v !== 0), `Empty RC profiles: ${item.id}`);
    }
  }
  assert.deepEqual(Object.keys(hashes).sort(), fs.readdirSync(directory).filter(name => name.endsWith('.f64')).sort(),
    'Unreferenced or missing numerical arrays');
  return { cases: byId.size, arrays: Object.keys(hashes).length, hashes, informativeVertices,
    execution, smoke, portParityVerified: false, compiledRuntimeVerified: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [directory, flag] = process.argv.slice(2);
  assert.ok(directory && (flag === undefined || flag === '--smoke'), 'Usage: validate-revcor-recording.mjs RECORDING [--smoke]');
  const report = validateRecording(directory, { smoke: flag === '--smoke' });
  fs.writeFileSync(path.join(directory, 'revcor-validation.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Validated ${report.cases} ${report.execution} cases and ${report.arrays} arrays. Port and compiled Runtime parity remain separate checks.`);
}
