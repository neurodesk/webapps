// The knowledge-base evidence port against the Python answers.
//
// apps/calmar/tests/fixtures/kb-parity/kb-parity.json is written by
// export_webapp.py --fixtures in the knowledge-base repository
// (github.com/micmas/stroke-aphasia-kb) with the real
// aphasia_kb / atlas_mapping code: synthetic overlap tables and what Python
// computes from them. The JavaScript must give the same unit and region
// damage, the same matched findings with the same contributions, the same
// per-target scores and the same therapies. Rows are compared after sorting
// on their keys because pandas' default sort is not stable on ties.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  unitDamage, regionDamage, locationFindings, interpretDamage, interpretTherapies, isSymptomTarget,
  disconnectionFromFractions, evaluateLesion, labelFor, displayName, evidenceStrength, canonicalAphasiaType,
  locationCoverage, reportSettings, designWeight, cohortGroupCount, measuresReport, lesionSizeNote, locationReport,
} from '../src/kb-evidence.js';
import { labelOverlap } from '../src/report-damage.js';

const kb = JSON.parse(await readFile(new URL('../../../apps/calmar/web/models/annotations/aphasia-kb.json', import.meta.url), 'utf8'));
const parity = JSON.parse(await readFile(new URL('../../../apps/calmar/tests/fixtures/kb-parity/kb-parity.json', import.meta.url), 'utf8'));

const near = (a, b, tol = 1e-9) => (a === null || a === undefined ? b === null || b === undefined : Math.abs(a - b) <= tol);
const by = (...keys) => (a, b) => {
  for (const k of keys) {
    const x = a[k]; const y = b[k];
    if (x === y) continue;
    return x > y ? 1 : -1;
  }
  return 0;
};

test('the exported knowledge base has the shape the port reads', () => {
  assert.equal(kb.schemaVersion, 1);
  assert.ok(kb.findings.length > 100);
  assert.ok(Object.keys(kb.mapping.units).length >= 50);
  assert.ok(Object.keys(kb.mapping.regions).length >= 80);
  assert.ok(kb.mapping.disconnectome.units.arcuate_fasciculus);
  assert.deepEqual(kb.version.statuses, ['approved']);
  for (const f of kb.findings) {
    assert.ok(typeof f.source_id === 'string' && f.source_kind && f.target_kind && Array.isArray(f.stages), f.id);
  }
});

for (const [name, fixture] of Object.entries(parity.cases)) {
  test(`unit and region damage match Python: ${name}`, () => {
    const units = unitDamage(fixture.input, kb.mapping);
    const expectedUnits = fixture.unitDamage.slice().sort(by('unit', 'side'));
    units.sort(by('unit', 'side'));
    assert.equal(units.length, expectedUnits.length);
    for (let i = 0; i < units.length; i += 1) {
      const got = units[i]; const want = expectedUnits[i];
      assert.equal(got.unit, want.unit); assert.equal(got.side, want.side);
      assert.equal(got.measured, want.measured, `${want.unit} ${want.side} measured`);
      assert.equal(got.overlap_voxels, want.overlap_voxels, `${want.unit} ${want.side} overlap`);
      assert.ok(near(got.lesion_pct, want.lesion_pct), `${want.unit} ${want.side} lesion_pct ${got.lesion_pct} vs ${want.lesion_pct}`);
      assert.ok(near(got.region_pct, want.region_pct), `${want.unit} ${want.side} region_pct ${got.region_pct} vs ${want.region_pct}`);
    }
    const damage = regionDamage(unitDamage(fixture.input, kb.mapping), kb.mapping).sort(by('region'));
    const expected = fixture.regionDamage.slice().sort(by('region'));
    assert.equal(damage.length, expected.length);
    for (let i = 0; i < damage.length; i += 1) {
      const got = damage[i]; const want = expected[i];
      assert.equal(got.region, want.region);
      assert.equal(got.measured, want.measured, `${want.region} measured`);
      assert.ok(near(got.lesion_pct, want.lesion_pct), `${want.region} lesion_pct ${got.lesion_pct} vs ${want.lesion_pct}`);
      assert.ok(near(got.region_pct, want.region_pct), `${want.region} region_pct ${got.region_pct} vs ${want.region_pct}`);
      assert.deepEqual(got.units_hit.slice().sort(), want.units_hit.slice().sort(), `${want.region} units_hit`);
      assert.equal(got.review, want.review);
    }
  });

  test(`matched findings, target scores and therapies match Python: ${name}`, () => {
    const damage = regionDamage(unitDamage(fixture.input, kb.mapping), kb.mapping);
    const pick = (r) => ({ region: r.region, source_id: r.source_id, finding_id: r.finding_id, predicts: r.predicts, contribution: r.contribution, design_w: r.design_w ?? 1, cohort_group: r.cohort_group ?? null });
    const rows = locationFindings(kb, damage, { minOverlap: 5, minRegion: 25 }).map(pick).sort(by('region', 'source_id', 'finding_id', 'predicts'));
    const expectedRows = fixture.locationFindings.map(pick).sort(by('region', 'source_id', 'finding_id', 'predicts'));
    assert.equal(rows.length, expectedRows.length, 'finding rows');
    for (let i = 0; i < rows.length; i += 1) {
      const { contribution, design_w, ...key } = rows[i];
      const { contribution: want, design_w: wantW, ...wantKey } = expectedRows[i];
      assert.deepEqual(key, wantKey);
      assert.ok(near(design_w, wantW, 1e-9), `${key.region}/${key.finding_id} design_w ${design_w} vs ${wantW}`);
      assert.ok(near(contribution, want, 1e-9), `${key.region}/${key.finding_id} ${contribution} vs ${want}`);
    }
    if (expectedRows.some((r) => r.design_w < 1)) assert.ok(rows.some((r) => r.design_w < 1), 'the v2.7 design penalty reaches some lesion-mapping findings');
    const imaging = interpretDamage(kb, damage, { minOverlap: 5, minRegion: 25 }).sort(by('target', 'target_kind'));
    const expectedImaging = fixture.interpretDamage.slice().sort(by('target', 'target_kind'));
    assert.equal(imaging.length, expectedImaging.length, 'targets');
    for (let i = 0; i < imaging.length; i += 1) {
      assert.equal(imaging[i].target, expectedImaging[i].target);
      assert.ok(near(imaging[i].score, expectedImaging[i].score, 1e-9), `${imaging[i].target} score`);
      assert.equal(imaging[i].n_findings, expectedImaging[i].n_findings);
      assert.deepEqual(imaging[i].citations, expectedImaging[i].citations);
      assert.deepEqual(imaging[i].contributing_regions, expectedImaging[i].contributing_regions);
      assert.equal(imaging[i].direction, expectedImaging[i].direction);
    }
    const ranked = interpretDamage(kb, damage, { minOverlap: 5, minRegion: 25 });
    const impairments = ranked.filter((r) => isSymptomTarget(kb, r.target, r.target_kind)).map((r) => r.target).slice(0, 10);
    // Python's head(10) after an unstable sort: the same score profile, and any
    // impairment chosen by one side only sits on the score tie at the cut.
    const scoreOf = new Map(ranked.map((r) => [r.target, Math.abs(r.score)]));
    const profile = (ids) => ids.map((id) => scoreOf.get(id)).sort((a, b) => b - a);
    assert.deepEqual(profile(impairments), profile(fixture.symptomImpairments));
    const boundary = profile(impairments).at(-1);
    for (const id of [...impairments, ...fixture.symptomImpairments]) {
      const inBoth = impairments.includes(id) && fixture.symptomImpairments.includes(id);
      assert.ok(inBoth || Math.abs(scoreOf.get(id) - boundary) < 1e-9, `${id} differs away from the tie at the cut`);
    }
    const therapies = interpretTherapies(kb, fixture.symptomImpairments, { maxResults: 5 })
      .map((t) => ({ therapy_id: t.therapy_id, score: t.score, lesion_matched: t.lesion_matched, citations: t.citations }))
      .sort(by('therapy_id'));
    const expectedTherapies = fixture.therapies
      .map((t) => ({ therapy_id: t.therapy_id, score: t.score, lesion_matched: t.lesion_matched, citations: t.citations }))
      .sort(by('therapy_id'));
    // Python's head(5) after an unstable sort on tied scores can pick different
    // therapies among equals; compare the score profile and every row that both
    // sides list.
    assert.deepEqual(therapies.map((t) => t.score).sort(), expectedTherapies.map((t) => t.score).sort());
    for (const want of expectedTherapies) {
      const got = therapies.find((t) => t.therapy_id === want.therapy_id);
      if (!got) continue;
      assert.deepEqual(got, want);
    }
  });
}

test('disconnection from ENIGMA streamline fractions matches Python', () => {
  const fixture = parity.disconnectome.arcuate_cut;
  const fractions = Object.fromEntries(Object.entries(fixture.fractions).map(([k, v]) => [k, v === null ? NaN : v]));
  const got = disconnectionFromFractions(fractions, kb.mapping).sort(by('region'));
  const want = fixture.regionDisconnection.slice().sort(by('region'));
  assert.deepEqual(got.map((r) => r.region), want.map((r) => r.region));
  for (let i = 0; i < got.length; i += 1) {
    assert.ok(near(got[i].region_pct, want[i].region_pct, 1e-9), `${got[i].region} ${got[i].region_pct} vs ${want[i].region_pct}`);
    assert.deepEqual(got[i].units_hit, want[i].units_hit);
    assert.equal(got[i].side, want[i].side);
  }
  const rows = locationFindings(kb, got, { minOverlap: 101, minRegion: 50 })
    .map((r) => [r.region, r.source_id, r.finding_id, r.predicts].join('|')).sort();
  const expectedRows = fixture.findings.map((r) => [r.region, r.source_id, r.finding_id, r.predicts].join('|')).sort();
  assert.deepEqual(rows, expectedRows);
  // The extreme capsule is reachable only through the disconnectome.
  assert.ok(got.some((r) => r.region === 'left_extreme_capsule' && r.region_pct === 55.00000000000001));
});

test('symptom filter, names and display bins follow the Python rules', () => {
  assert.equal(isSymptomTarget(kb, 'brocas_aphasia', 'impairment'), false);
  assert.equal(isSymptomTarget(kb, 'aphasia', 'impairment'), false);
  assert.equal(isSymptomTarget(kb, 'apraxia_of_speech', 'impairment'), true);
  assert.equal(isSymptomTarget(kb, 'apraxia_of_speech', 'therapy'), false);
  assert.equal(canonicalAphasiaType(kb, "Broca's aphasia"), 'brocas_aphasia');
  assert.equal(canonicalAphasiaType(kb, 'TranscorticalMotor'), 'transcortical_motor_aphasia');
  assert.equal(canonicalAphasiaType(kb, 'apraxia'), null);
  assert.equal(displayName(kb, 'left_ifg_pars_opercularis__Fridriksson2018'), 'Left IFG pars opercularis');
  assert.equal(labelFor(kb, 'no_such_entry'), 'no_such_entry');
  assert.deepEqual(evidenceStrength(kb, 0), [0, 'no net evidence']);
  assert.deepEqual(evidenceStrength(kb, -2), [2, 'moderate']);
  assert.deepEqual(evidenceStrength(kb, 12), [4, 'very strong / replicated']);
  const coverage = locationCoverage(kb, [], []);
  assert.ok(coverage.findings > 0 && coverage.unmappable >= 0 && coverage.undamaged <= coverage.findings);
});

test('design weighting, cohort groups and the measures section follow the v2.7 Python', () => {
  const rules = kb.rules;
  assert.equal(designWeight(rules, { lm_source: null }), 1, 'not a lesion-mapping finding');
  assert.equal(designWeight(rules, { lm_source: 'inferred', lm_volume_correction: 'covariate', lm_correction: 'fdr' }), 1);
  assert.ok(near(designWeight(rules, { lm_source: 'filled', lm_volume_correction: 'none', lm_correction: 'fdr' }), 0.8));
  assert.ok(near(designWeight(rules, { lm_source: 'stated', lm_volume_correction: 'not_reported', lm_correction: 'uncorrected' }), 0.64));
  assert.ok(near(designWeight(rules, { lm_source: 'stated', lm_volume_correction: 'direct', lm_correction: 'not_reported' }), 0.8));
  assert.equal(cohortGroupCount([{ citation: '@A', cohort_group: 'ARC' }, { citation: '@B', cohort_group: 'ARC' }, { citation: '@C', cohort_group: '@C' }, { citation: null }]), 2);
  // Every exported finding carries the group its Python table has.
  for (const f of kb.findings) assert.equal(typeof f.cohort_group, 'string', `${f.source_id}/${f.id} cohort_group`);
  // The primary criterion counts groups: a symptom backed by two papers of one cohort is not primary.
  const fixture = parity.cases.left_perisylvian;
  const damage = regionDamage(unitDamage(fixture.input, kb.mapping), kb.mapping);
  const report = locationReport(kb, locationFindings(kb, damage, { minOverlap: 5, minRegion: 25 }), damage);
  for (const s of report.summaries) {
    assert.ok(s.groups <= s.citations.length, `${s.target}: groups never exceed citation keys`);
    assert.equal(s.primary, s.groups >= 2 && s.anatomies >= 2, `${s.target} primary by groups`);
  }
  // Measures: lesion volume against the Python measures_section fixture.
  const want = parity.measures.lesion_volume;
  const [measure] = measuresReport(kb, { lesion_volume: 42.5 });
  assert.equal(measure.id, 'lesion_volume');
  assert.equal(measure.value, 42.5);
  assert.equal(measure.units, 'ml (cc)');
  assert.equal(measure.distinct, want.distinct);
  assert.deepEqual(measure.directionCounts, want.directionCounts);
  assert.equal(measure.polarity, 'higher values go with worse language or recovery');
  const ids = measure.outcomes.flatMap((g) => g.findings.map((f) => `${f.citation}/${f.finding_id}`)).sort();
  const wantIds = [...new Set(want.findings.map((f) => `${f.citation}/${f.finding_id}`))].sort();
  for (const id of ids) assert.ok(wantIds.includes(id), id);
  assert.deepEqual(measuresReport(kb, {}), []);
  assert.deepEqual(measuresReport(kb, { no_such_measure: 1 }), []);
  assert.deepEqual(lesionSizeNote(12.34, [{ region: 'a' }, { region: 'a' }, { region: 'b' }]), { volumeMl: 12.34, regions: 2 });
  assert.equal(lesionSizeNote(null, []), null);
});

test('evaluateLesion assembles the three sections from a damage table', () => {
  const fixture = parity.cases.left_perisylvian;
  const damage = regionDamage(unitDamage(fixture.input, kb.mapping), kb.mapping);
  const fractions = Object.fromEntries(Object.entries(parity.disconnectome.arcuate_cut.fractions).map(([k, v]) => [k, v === null ? NaN : v]));
  const result = evaluateLesion(kb, { damage, disconnection: disconnectionFromFractions(fractions, kb.mapping), lesionVolumeMl: 30 });
  assert.equal(result.settings.minOverlapPct, 5);
  assert.equal(result.measures.length, 1);
  assert.equal(result.lesionSize.volumeMl, 30);
  assert.equal(result.lesionSize.regions, new Set(result.rows.map((r) => r.region)).size);
  assert.equal(evaluateLesion(kb, { damage }).lesionSize, null);
  assert.ok(result.location.summaries.length > 0);
  for (const s of result.location.summaries) assert.ok(isSymptomTarget(kb, s.target, s.kind), s.target);
  assert.ok(result.location.summaries.every((s, i, all) => i === 0 || Math.abs(all[i - 1].score) >= Math.abs(s.score)));
  assert.ok(result.location.regions.length > 0);
  assert.ok(result.location.regions[0].outcomes.length > 0);
  assert.ok(result.whiteMatter.tracts.length > 0);
  assert.ok(result.whiteMatter.tracts.some((t) => t.shared.length > 0), 'a tract shares a symptom target with the direct-damage evidence');
  assert.ok(result.therapy.length > 0 && result.therapy[0].lesion_names.length > 0);
  assert.equal(result.therapy[0].stageMismatch, null);
  const chronic = evaluateLesion(kb, { damage, stage: 'acute' });
  assert.ok(chronic.therapy.some((t) => t.stageMismatch));
  const empty = evaluateLesion(kb, { damage: regionDamage(unitDamage({}, kb.mapping), kb.mapping) });
  assert.deepEqual(empty.location.summaries, []);
  assert.deepEqual(empty.therapy, []);
});

test('labelOverlap reproduces the overlap table columns, with sides from world x', () => {
  const dims = [4, 1, 1];
  // Voxel x: affine x = -2*i + 3 -> i=0: 3 (right), 1: 1 (right), 2: -1 (left), 3: -3 (left).
  const affine = [[-2, 0, 0, 3], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const atlas = Int16Array.from([7, 7, 7, 0]);
  const lesion = Uint8Array.from([1, 0, 1, 1]);
  const { rows, totalLesionVoxels } = labelOverlap({ lesion, atlas, dims, affine, labels: { 7: 'Precentral Gyrus' } });
  assert.equal(totalLesionVoxels, 3);
  assert.deepEqual(rows, [{
    region: 'Precentral Gyrus', region_id: 7, overlap_voxels: 2, total_region_voxels: 3, total_lesion_voxels: 3,
    lesion_in_roi_percent: 200 / 3, roi_coverage_percent: 200 / 3,
    left_overlap_voxels: 1, right_overlap_voxels: 1, midline_overlap_voxels: 0,
    left_region_voxels: 1, right_region_voxels: 2,
  }]);
  assert.throws(() => labelOverlap({ lesion, atlas: new Int16Array(3), dims, affine }), /match dims/);
  const settings = reportSettings(kb, { topN: 3 });
  assert.equal(settings.topN, 3);
  assert.equal(settings.minDisconnectedPct, 50);
});
