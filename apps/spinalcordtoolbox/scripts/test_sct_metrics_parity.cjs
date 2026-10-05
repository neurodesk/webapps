#!/usr/bin/env node
'use strict';

/*
 * Parity of the browser metric modules with real SCT 7.3.
 *
 * test/fixtures/sct-metrics holds tables written by `sct_process_segmentation`
 * and `sct_analyze_lesion` in the pinned SCT container
 * (scripts/generate_sct_metric_references.cjs). This test runs
 * sct-morphometry.js and lesion-analysis.js on the same masks and compares
 * every cell: same columns in the same order, same rows, same empty cells,
 * and every number within TOLERANCE of SCT's.
 *
 * The tolerance is floating-point noise only (different summation order in
 * NumPy/BLAS versus JavaScript). A real disagreement must be fixed in the
 * module or recorded in the app's AGENTS.md, not absorbed here.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ensureFixtureFiles } = require('./huggingface-fixtures.cjs');
const {
  morphometry,
  lesionAnalysis,
  loadRpiVolume,
  rpiFromStoredIndices,
  nativeFlipsForOrientation,
  parseCsv
} = require('./sct-metrics-lib.cjs');

const ROOT = path.resolve(__dirname, '..');
const FIXTURE_DIR = path.join(ROOT, 'test/fixtures/sct-metrics');
const cases = require(path.join(FIXTURE_DIR, 'cases.json'));
const TOLERANCE = 1e-9;
const UNCORRECTED_WITHOUT_CORD = new Set(['length [mm]', 'width [mm]', 'max_equivalent_diameter [mm]']);
const VERBOSE = process.argv.includes('--report');

const worst = new Map();

function recordDifference(group, column, expected, actual, where) {
  const difference = Math.abs(expected - actual);
  const key = `${group}|${column}`;
  const current = worst.get(key);
  if (!current || difference > current.difference) {
    worst.set(key, { group, column, difference, expected, actual, where });
  }
  return difference;
}

function assertNumber(group, column, expectedText, actualText, where) {
  const expected = Number(expectedText);
  const actual = Number(actualText);
  assert.ok(Number.isFinite(expected) && Number.isFinite(actual), `${where} ${column}: "${expectedText}" vs "${actualText}"`);
  const difference = recordDifference(group, column, expected, actual, where);
  const allowed = TOLERANCE * Math.max(1, Math.abs(expected));
  assert.ok(difference <= allowed, `${where} ${column}: SCT ${expectedText}, app ${actualText}, difference ${difference}`);
}

function referenceTable(id) {
  const rows = parseCsv(fs.readFileSync(path.join(FIXTURE_DIR, `${id}.csv`), 'utf8'));
  return { header: rows[0].map(field => field.text), rows: rows.slice(1) };
}

async function checkMorphometry(item, volumes, discs) {
  const mask = volumes[item.mask];
  const result = morphometry.processSegmentation({
    seg: mask.data,
    dims: mask.dims,
    spacing: mask.spacing,
    discs: item.discs ? discs : null,
    nativeFlips: item.orient ? nativeFlipsForOrientation(item.orient) : mask.nativeFlips,
    ...item.app,
    filename: `${item.mask}.nii.gz`,
    version: cases.sctVersion
  });
  const expected = referenceTable(item.id);
  const actualRows = parseCsv(result.csv);
  const actual = { header: actualRows[0].map(field => field.text), rows: actualRows.slice(1) };

  assert.deepEqual(actual.header, expected.header, `${item.id}: CSV columns match SCT's, in order`);
  assert.equal(actual.rows.length, expected.rows.length, `${item.id}: row count`);
  assert.ok(result.csv.endsWith('\r\n') && !/[^\r]\n/.test(result.csv), `${item.id}: rows end in CRLF like Python's csv module`);

  const sliceColumn = expected.header.indexOf('Slice (I->S)');
  const actualBySlice = new Map(actual.rows.map(row => [row[sliceColumn].text, row]));
  for (const expectedRow of expected.rows) {
    const slices = expectedRow[sliceColumn].text;
    const actualRow = actualBySlice.get(slices);
    assert.ok(actualRow, `${item.id}: a row for slices ${slices}`);
    expected.header.forEach((column, index) => {
      const where = `${item.id} slices ${slices}`;
      const expectedField = expectedRow[index];
      const actualField = actualRow[index];
      assert.equal(actualField.quoted, expectedField.quoted, `${where} ${column}: quoting`);
      if (column === 'Timestamp') {
        assert.match(actualField.text, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/, `${where}: timestamp format`);
      } else if (column === 'Filename') {
        assert.equal(path.basename(actualField.text), path.basename(expectedField.text).replace(/_[A-Z]{3}(?=\.nii)/, ''), `${where}: filename`);
      } else if (expectedField.quoted) {
        assert.equal(actualField.text, expectedField.text, `${where} ${column}`);
      } else {
        assertNumber('sct_process_segmentation', column, expectedField.text, actualField.text, where);
      }
    });
  }
  // SCT sorts rows by slice group; so does the app.
  assert.deepEqual(
    actual.rows.map(row => row[sliceColumn].text),
    expected.rows.map(row => row[sliceColumn].text),
    `${item.id}: row order`
  );
  return expected.rows.length;
}

async function checkLesion(item, volumes) {
  // A lesion-only case has no cord: the lesion mask gives the grid.
  const cord = volumes[item.cord || item.lesion];
  let lesion;
  if (item.synthetic) {
    const stored = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `${item.lesion}.json`), 'utf8'));
    assert.deepEqual(stored.dims, cord.origDims, `${item.id}: synthetic mask is on the cord grid`);
    lesion = await rpiFromStoredIndices(stored.indices, cord);
  } else {
    lesion = volumes[item.lesion].data;
  }
  const result = lesionAnalysis.analyzeLesions({
    lesion,
    spinalCord: item.cord ? cord.data : null,
    dims: cord.dims,
    spacing: cord.spacing,
    nativeFlips: cord.nativeFlips,
    image: item.image ? volumes[item.image].data : null,
    imageName: item.image || null
  });
  const expected = referenceTable(item.id);
  const actualRows = parseCsv(result.csv);
  assert.deepEqual(actualRows[0].map(field => field.text), expected.header, `${item.id}: columns match SCT's measures sheet, in order`);
  assert.equal(actualRows.length - 1, expected.rows.length, `${item.id}: lesion count`);
  expected.rows.forEach((expectedRow, rowIndex) => {
    const actualRow = actualRows[rowIndex + 1];
    expected.header.forEach((column, index) => {
      const where = `${item.id} lesion ${expectedRow[0].text}`;
      if (column === 'label') {
        assert.equal(actualRow[index].text, expectedRow[index].text, `${where}: label`);
      } else if (expectedRow[index].text === '' && !item.cord && UNCORRECTED_WITHOUT_CORD.has(column)) {
        // Documented extension: SCT leaves these empty without -s.
        assert.ok(Number.isFinite(Number(actualRow[index].text)), `${where} ${column}: the app measures it without a cord`);
      } else if (expectedRow[index].text === '') {
        assert.equal(actualRow[index].text, '', `${where} ${column}: empty in SCT`);
      } else {
        // slice_N columns differ per lesion; report them under one name.
        const name = column.replace(/^slice_\d+_/, 'slice_N_');
        assertNumber('sct_analyze_lesion', name, expectedRow[index].text, actualRow[index].text, where);
      }
    });
  });
  return expected.rows.length;
}

async function main() {
  const needed = Object.entries(cases.inputs)
    .filter(([name]) => !cases.referenceOnlyInputs.includes(name))
    .map(([, relativePath]) => relativePath);
  await ensureFixtureFiles(ROOT, needed);

  const volumes = {};
  for (const [name, relativePath] of Object.entries(cases.inputs)) {
    if (cases.referenceOnlyInputs.includes(name)) continue;
    volumes[name] = await loadRpiVolume(path.join(ROOT, relativePath));
  }
  const discs = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 't2_discs.json'), 'utf8')).points;

  let rows = 0;
  for (const item of cases.morphometry) rows += await checkMorphometry(item, volumes, discs);
  let lesions = 0;
  for (const item of cases.lesion) lesions += await checkLesion(item, volumes);

  if (VERBOSE) {
    console.log('tool,metric,max |SCT - app|,SCT,app,where');
    for (const entry of worst.values()) {
      console.log([entry.group, entry.column, entry.difference.toExponential(2), entry.expected, entry.actual, entry.where].join(','));
    }
  }
  const largest = [...worst.values()].reduce((max, entry) => Math.max(max, entry.difference), 0);
  console.log(
    `SCT metric parity passed: ${cases.morphometry.length} sct_process_segmentation runs (${rows} rows) and `
    + `${cases.lesion.length} sct_analyze_lesion runs (${lesions} lesions) match ${cases.image}; `
    + `largest difference ${largest.toExponential(2)}`
  );
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
