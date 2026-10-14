import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import manifest from '../model.manifest.json' with { type: 'json' };

import {
  NORMS_SCHEMA,
  assess,
  centile,
  footerLines,
  headerLines,
  modelKey,
  normalCdf,
  normalQuantile,
  parseNorms,
  percentileText,
  scaledAge,
  subjectFromSidecar,
  wholeYears,
} from '../src/brainquant.js';

const fixture = (name) => new URL(`./fixtures/${name}`, import.meta.url);
const rawNorms = JSON.parse(readFileSync(fixture('brainquant_norms.json'), 'utf8'));
const golden = JSON.parse(readFileSync(fixture('brainquant-golden.json'), 'utf8'));
const norms = parseNorms(rawNorms);

test('the population data version identifies the immutable, checksummed reference', () => {
  const commit = new URL(manifest.norms.url).pathname.split('/')[3];
  assert.match(commit, /^[a-f0-9]{40}$/);
  assert.equal(manifest.norms.version, commit.slice(0, 12));
  const bytes = readFileSync(fixture('brainquant_norms.json'));
  assert.equal(bytes.byteLength, manifest.norms.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), manifest.norms.sha256);
});

function readVolumes(text) {
  const [header, row] = text.trim().split(/\r?\n/).map((line) => line.split(','));
  return Object.fromEntries(header.slice(1).map((name, index) => [name.trim(), Number(row[index + 1])]));
}

const volumes = readVolumes(readFileSync(fixture('T1_head_fast_vol.csv'), 'utf8'));

function assertRelative(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance * Math.abs(expected), `${label}: ${actual} vs ${expected}`);
}

function assertAbsolute(actual, expected, tolerance, label) {
  if (expected === null) {
    assert.equal(actual, null, label);
    return;
  }
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} vs ${expected}`);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

test('assess reproduces brainquant.py on every golden case', () => {
  assert.equal(golden.cases.length, 5);
  for (const expected of golden.cases) {
    const report = assess(norms, volumes, { age: expected.age, sex: expected.sex });
    const label = `age ${expected.age} sex ${expected.sex}`;
    assertRelative(report.icvMm3, expected.icv_mm3, 1e-9, `${label} icv`);
    assert.deepEqual(report.results.map((result) => result.id), expected.results.map((result) => result.id));
    report.results.forEach((result, index) => {
      const want = expected.results[index];
      const where = `${label} ${want.id}`;
      assertRelative(result.volumeMm3, want.volume_mm3, 1e-9, `${where} volume`);
      assertRelative(result.adjustedMm3, want.adjusted_mm3, 1e-9, `${where} adjusted`);
      assertAbsolute(result.z, want.z, 1e-9, `${where} z`);
      assertAbsolute(result.percentile, want.percentile, 1e-9, `${where} percentile`);
      assert.equal(result.flag, want.flag, `${where} flag`);
    });
  }
});

test('the golden cases exercise both flags and the unknown-age path', () => {
  const flags = new Set(golden.cases.flatMap((entry) => entry.results.map((result) => result.flag)));
  assert.ok(flags.has('<5th') || flags.has('>95th'), 'a golden case is flagged');
  assert.ok(golden.cases.some((entry) => entry.age === null));
});

test('centiles reproduce the hippocampus curves at 20, 50 and 86.3 years', () => {
  const curves = golden['hippocampus_left_female_centiles_at_20_50_86.3'];
  const model = norms.structures.find((entry) => entry.id === 'hippocampus_left').models.female;
  for (const [quantile, values] of Object.entries(curves)) {
    [20, 50, 86.3].forEach((age, index) => {
      assertRelative(centile(model, scaledAge(norms, age), Number(quantile)), values[index], 1e-9, `q ${quantile} age ${age}`);
    });
  }
});

test('outsideReferenceAge is set only for a known age beyond the reference range', () => {
  assert.equal(assess(norms, volumes, { age: 95, sex: 'female' }).outsideReferenceAge, true);
  assert.equal(assess(norms, volumes, { age: 86.3, sex: 'female' }).outsideReferenceAge, false);
  assert.equal(assess(norms, volumes, { age: null, sex: null }).outsideReferenceAge, false);
});

test('assess rejects incomplete or empty volumes', () => {
  const { 'left hippocampus': _, ...withoutHippocampus } = volumes;
  assert.throws(
    () => assess(norms, withoutHippocampus, { age: 45, sex: 'female' }),
    { message: "SynthSeg volume CSV is missing columns required by the norms: ['left hippocampus']" },
  );
  assert.throws(
    () => assess(norms, { ...volumes, 'total intracranial': 0 }, { age: 45, sex: 'female' }),
    { message: 'SynthSeg reported a non-positive total intracranial volume' },
  );
  assert.throws(
    () => assess(norms, { ...volumes, 'left amygdala': 0 }, { age: 45, sex: 'female' }),
    { message: 'SynthSeg reported no volume for Left amygdala' },
  );
});

test('flags mark percentiles below the 5th and above the 95th', () => {
  const subject = { age: 60, sex: 'male' };
  const model = norms.structures.find((entry) => entry.id === 'hippocampus_left').models.male;
  const logIcvRatio = Math.log(volumes['total intracranial']) - Math.log(norms.referenceIcvMm3);
  const volumeAt = (percentile) => Math.exp(Math.log(centile(model, scaledAge(norms, 60), percentile / 100)) + model.icvSlope * logIcvRatio);
  for (const [percentile, flag] of [[3, '<5th'], [5.1, ''], [50, ''], [94.9, ''], [97, '>95th']]) {
    const [result] = assess(norms, { ...volumes, 'left hippocampus': volumeAt(percentile) }, subject).results;
    assertAbsolute(result.percentile, percentile, 1e-9, `percentile ${percentile}`);
    assert.equal(result.flag, flag, `flag at ${percentile}`);
  }
});

test('modelKey falls back to the combined model without a sex', () => {
  assert.equal(modelKey({ age: 40, sex: 'male' }), 'male');
  assert.equal(modelKey({ age: 40, sex: null }), 'all');
});

test('normalCdf and normalQuantile match scipy and invert each other', () => {
  assertRelative(normalCdf(-1.96), 0.024997895148220435, 1e-12, 'ndtr(-1.96)');
  assertRelative(normalQuantile(0.975), 1.959963984540054, 1e-12, 'ndtri(0.975)');
  assert.equal(normalCdf(0), 0.5);
  const ndtr = [
    [-30, 4.906713927147908e-198],
    [-10, 7.61985302416047e-24],
    [-6, 9.865876450376946e-10],
    [-3, 0.0013498980316300933],
    [-1.5, 0.06680720126885807],
    [-0.6, 0.2742531177500736],
    [-0.2, 0.42074029056089696],
    [0.1, 0.539827837277029],
    [0.5, 0.6914624612740131],
    [1, 0.8413447460685429],
    [2.5, 0.9937903346742238],
    [5, 0.9999997133484281],
  ];
  for (const [z, expected] of ndtr) {
    assertRelative(normalCdf(z), expected, 1e-12, `ndtr(${z})`);
  }
  const ndtri = [
    [1e-20, -9.262340089798409],
    [0.001, -3.090232306167813],
    [0.03, -1.880793608151251],
    [0.2, -0.8416212335729142],
    [0.6, 0.2533471031357997],
    [0.99, 2.3263478740408408],
  ];
  for (const [p, expected] of ndtri) {
    assertRelative(normalQuantile(p), expected, 1e-12, `ndtri(${p})`);
  }
  assert.equal(normalQuantile(0.5), 0);
  for (const p of [1e-300, 1e-10, 0.001, 0.02425, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999, 1 - 1e-12]) {
    assertRelative(normalCdf(normalQuantile(p)), p, 1e-12, `cdf(quantile(${p}))`);
  }
  for (const z of [-8, -3.5, -1, -0.3, 0.2, 1.5, 2]) {
    assertAbsolute(normalQuantile(normalCdf(z)), z, 1e-12 * Math.max(1, Math.abs(z)), `quantile(cdf(${z}))`);
  }
  assert.equal(normalQuantile(0), -Infinity);
  assert.equal(normalQuantile(1), Infinity);
});

test('parseNorms returns the reference and structures as frozen data', () => {
  assert.equal(norms.reference.ageMax, 86.3);
  assert.equal(norms.icvColumn, 'total intracranial');
  assert.equal(norms.structures.length, 10);
  assert.ok(Object.isFrozen(norms.structures[0].models.all.mu));
  assert.deepEqual(norms.structures[0].models.female.logSigma, rawNorms.structures[0].models.female.log_sigma);
});

test('parseNorms rejects malformed norms', () => {
  assert.throws(
    () => parseNorms({ ...rawNorms, schema: 'other/1' }),
    { message: `Brain volume norms schema 'other/1', expected ${NORMS_SCHEMA}` },
  );
  const withoutModels = clone(rawNorms);
  delete withoutModels.structures[2].models;
  assert.throws(() => parseNorms(withoutModels), { message: "Brain volume norms are missing field 'models'" });
  const withoutAll = clone(rawNorms);
  delete withoutAll.structures[0].models.all;
  assert.throws(
    () => parseNorms(withoutAll),
    { message: "Brain volume norms: structure hippocampus_left models ['female', 'male'], expected ['female', 'male', 'all']" },
  );
  const nonFinite = clone(rawNorms);
  nonFinite.structures[1].models.male.icv_slope = 'NaN';
  assert.throws(
    () => parseNorms(nonFinite),
    { message: "Brain volume norms: hippocampus_right.male.icv_slope must be a finite number, got 'NaN'" },
  );
  const shortMu = clone(rawNorms);
  shortMu.structures[0].models.female.mu = [1, 2];
  assert.throws(
    () => parseNorms(shortMu),
    { message: 'Brain volume norms: hippocampus_left.female.mu must list 3 numbers, got [1, 2]' },
  );
  const noColumns = clone(rawNorms);
  noColumns.structures[0].columns = [];
  assert.throws(() => parseNorms(noColumns), { message: 'Brain volume norms: structure hippocampus_left needs CSV columns' });
  assert.throws(
    () => parseNorms({ ...rawNorms, age_scale: 0 }),
    { message: 'Brain volume norms need structures and positive age_scale and reference ICV' },
  );
});

test('percentileText rounds half to even like Python', () => {
  const cases = [
    [null, 'n/a'],
    [0.5, '<1st'],
    [99.5, '>99th'],
    [1, '1st'],
    [11.4, '11th'],
    [21.6, '22nd'],
    [2.5, '2nd'],
    [3.4, '3rd'],
    [12.5, '12th'],
    [22.5, '22nd'],
    [50.5, '50th'],
    [99, '99th'],
  ];
  for (const [percentile, text] of cases) {
    assert.equal(percentileText(percentile), text, String(percentile));
  }
});

const reference = 'Reference: IXI (n=561, 311 F / 250 M, age 20-86.3 y, CC BY-SA 3.0), SynthSeg 2.0, fast mode, FreeSurfer 8.2.0 mri_synthseg --vol.';
const adjusted = 'Adjusted volume: scaled to the reference total intracranial volume of 1500 mL. Bands: 5th-95th and 25th-75th percentiles; line: median.';

test('report text for a known subject outside the reference age', () => {
  const report = assess(norms, volumes, { age: 95, sex: 'female' });
  assert.deepEqual(headerLines(report, norms), [
    'Patient: 95 y, female.  Total intracranial volume 1592 mL.',
    reference,
    'Research use only. Not for diagnostic use.',
  ]);
  assert.deepEqual(footerLines(report, norms, ['Note A.']), [
    'Note A.',
    'Patient age 95 y is outside the reference age range 20-86.3 y; the curves are extrapolated.',
    adjusted,
  ]);
});

test('report text for an unknown subject', () => {
  const report = assess(norms, volumes, { age: null, sex: null });
  assert.deepEqual(headerLines(report, norms), [
    'Patient: unknown age, unknown sex.  Total intracranial volume 1592 mL.',
    'Sex unknown: compared with the combined female and male reference.',
    reference,
    'Research use only. Not for diagnostic use.',
  ]);
  assert.deepEqual(footerLines(report, norms), [adjusted]);
});

test('subjectFromSidecar reads age and sex from a dcm2niix sidecar', () => {
  assert.deepEqual(subjectFromSidecar({ PatientAge: '045Y', PatientSex: 'F' }), { age: 45, sex: 'female' });
  assert.deepEqual(subjectFromSidecar({ PatientAge: 62, PatientSex: 'M' }), { age: 62, sex: 'male' });
  assert.deepEqual(
    subjectFromSidecar({ PatientAge: '018M', PatientBirthDate: '1970-01-31', AcquisitionDateTime: '2020-01-30T10:11:12.000000' }),
    { age: 49, sex: null },
  );
  assert.deepEqual(
    subjectFromSidecar({ PatientBirthDate: '19700131', AcquisitionDate: '2020-01-31', PatientSex: 'O' }),
    { age: 50, sex: null },
  );
  assert.deepEqual(subjectFromSidecar({ PatientBirthDate: '19700131', StudyDate: '20200130' }), { age: 49, sex: null });
  assert.deepEqual(
    subjectFromSidecar({ PatientBirthDate: '1970-01-31', AcquisitionDateTime: '2020-06-01T00:00:00', StudyDate: '19990101' }),
    { age: 50, sex: null },
  );
  assert.deepEqual(subjectFromSidecar({ PatientBirthDate: '2021-01-01', StudyDate: '20200101' }), { age: null, sex: null });
  assert.deepEqual(subjectFromSidecar({ PatientBirthDate: '2020-01-02', StudyDate: '20200101' }), { age: null, sex: null });
  assert.deepEqual(subjectFromSidecar({ PatientBirthDate: '1970-01-31' }), { age: null, sex: null });
  assert.deepEqual(subjectFromSidecar({ PatientBirthDate: '19701331', StudyDate: '20200101' }), { age: null, sex: null });
  assert.deepEqual(subjectFromSidecar({}), { age: null, sex: null });
});

test('wholeYears counts completed birthdays', () => {
  assert.equal(wholeYears({ year: 2000, month: 2, day: 29 }, { year: 2021, month: 2, day: 28 }), 20);
  assert.equal(wholeYears({ year: 2000, month: 2, day: 29 }, { year: 2021, month: 3, day: 1 }), 21);
  assert.equal(wholeYears({ year: 1980, month: 6, day: 15 }, { year: 2020, month: 6, day: 15 }), 40);
});
