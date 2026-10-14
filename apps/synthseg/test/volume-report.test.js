import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseNorms } from '@neurodesk/synthseg/brainquant';
import { parseVolumesCsv } from '@neurodesk/synthseg/results';
import { chartSvg, legendEntries, tickStep, volumeReport } from '../src/volume-report.js';

const fixtures = new URL('../../../packages/synthseg/test/fixtures/', import.meta.url);
const norms = parseNorms(JSON.parse(await readFile(new URL('brainquant_norms.json', fixtures), 'utf8')));
const { volumes } = parseVolumesCsv(await readFile(new URL('T1_head_fast_vol.csv', fixtures), 'utf8'));
const golden = JSON.parse(await readFile(new URL('brainquant-golden.json', fixtures), 'utf8'));

const attribute = (svg, element, name) => svg.match(new RegExp(`<${element} class="[^"]*"[^>]*\\b${name}="([^"]+)"`))?.[1];

test('the population data version is visible above the charts', () => {
  const { header } = volumeReport(norms, volumes, { age: 45, sex: 'female' });
  assert.ok(header.includes('Population data: IXI, version b23bda1938a5.'));
});

test('the report rows carry the reference implementation\'s numbers', () => {
  const expected = golden.cases.find((entry) => entry.age === 72 && entry.sex === 'male');
  const { rows, charts } = volumeReport(norms, volumes, { age: 72, sex: 'male' });
  assert.equal(rows.length, expected.results.length);
  for (const [index, row] of rows.entries()) {
    const reference = expected.results[index];
    assert.equal(row.id, reference.id);
    assert.equal(row.adjustedMl, (reference.adjusted_mm3 / 1000).toFixed(2));
    assert.equal(row.flag, reference.flag);
    assert.equal(charts[index].flagged, reference.flag !== '');
  }
  assert.equal(rows[0].z, '+2.26');
  assert.equal(charts[0].caption, 'Left hippocampus: 99th');
});

test('a known age places the subject as a dot at that age and adjusted volume', () => {
  const { charts, report } = volumeReport(norms, volumes, { age: 45, sex: 'female' });
  const svg = charts[0].svg;
  assert.match(svg, /<circle class="nd-chart-marker"/);
  assert.doesNotMatch(svg, /nd-chart-level|nd-chart-range/);
  assert.match(svg, /<title>4\.71 mL at 45 y<\/title>/);
  assert.equal(report.results[0].adjustedMm3.toFixed(3), (golden.cases[0].results[0].adjusted_mm3).toFixed(3));
});

test('an unknown age draws a dashed level across the chart and uses the pooled model', () => {
  const { charts, header } = volumeReport(norms, volumes, { age: null, sex: null });
  assert.match(charts[0].svg, /<line class="nd-chart-level"/);
  assert.doesNotMatch(charts[0].svg, /<circle/);
  assert.equal(charts[0].caption, 'Left hippocampus: n/a');
  assert.ok(header.includes('Sex unknown: compared with the combined female and male reference.'));
});

test('an age outside the cohort extends the axis, boxes the reference ages and says so', () => {
  const { charts, footer } = volumeReport(norms, volumes, { age: 95, sex: 'female' });
  assert.match(charts[0].svg, /<rect class="nd-chart-range"/);
  assert.match(charts[0].svg, /outside reference age range/);
  assert.ok(footer.some((line) => line.startsWith('Patient age 95 y is outside the reference age range 20-86.3 y')));
  assert.ok(Number(attribute(charts[0].svg, 'circle', 'cx')) > Number(attribute(charts[0].svg, 'rect', 'x')));
});

test('a default-mode run is footnoted, a fast run is not', () => {
  const fast = volumeReport(norms, volumes, { age: 45, sex: 'female' });
  const slow = volumeReport(norms, volumes, { age: 45, sex: 'female' }, { fast: false });
  assert.equal(slow.footer.length, fast.footer.length + 1);
  assert.match(slow.footer[0], /fast mode/);
});

test('coarser grids carry a warning beside the normative volume results', () => {
  const standard = volumeReport(norms, volumes, { age: 45, sex: 'female' });
  const coarse = volumeReport(norms, volumes, { age: 45, sex: 'female' }, { voxelSizeMm: 1.5 });
  assert.equal(coarse.header.length, standard.header.length + 1);
  assert.equal(coarse.header.at(-1), 'This run used 1.5 mm voxels. The 1 mm reference norms have not been validated for this grid.');
  assert.deepEqual(coarse.footer, standard.footer);
});

test('the chart maps values onto the plot and closes each band', () => {
  const ages = [20, 50, 80];
  const curves = [[1, 1, 1], [2, 2, 2], [3, 3, 3], [4, 4, 4], [5, 5, 5]];
  const svg = chartSvg({ ages, curves, domain: [20, 80], patient: { age: 50, adjustedMl: 3 }, reference: null, label: 'x' });
  assert.equal(attribute(svg, 'polyline', 'points'), '40,70 136,70 232,70');
  assert.equal(attribute(svg, 'circle', 'cx'), '136');
  assert.equal(attribute(svg, 'circle', 'cy'), '70');
  const outer = attribute(svg, 'polygon', 'points').split(' ');
  assert.deepEqual(outer, ['40,8', '136,8', '232,8', '232,132', '136,132', '40,132']);
});

test('tick steps are 1, 2 or 5 times a power of ten', () => {
  assert.equal(tickStep(66), 20);
  assert.equal(tickStep(1.7), 0.5);
  assert.equal(tickStep(4), 1);
});

test('the legend names the dot or the dashed level', () => {
  assert.equal(legendEntries(true)[0].label, 'patient (adjusted volume)');
  assert.equal(legendEntries(false)[0].label, 'patient (age unknown)');
  assert.equal(legendEntries(true).length, 4);
});
