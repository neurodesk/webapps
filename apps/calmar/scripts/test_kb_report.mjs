#!/usr/bin/env node
// The knowledge-base report stage in the browser module (web/js/modules/kb-report.js):
//
//   * asset lookup from the manifest (KB JSON, the hosted report atlases, the
//     disconnectome atlas), with an unhosted atlas reported as missing;
//   * the lesion copied onto a label grid by world coordinates and reduced to
//     the overlap rows the knowledge-base mapping reads (measureDamage);
//   * the lesion written onto the MNI152 1 mm disconnectome grid;
//   * the disconnectome worker (web/js/disconnectome-worker.js) run in-process
//     through DisconnectomeClient against a TVX atlas built from the nii2tvx
//     fixtures with the native tool, including its error paths;
//   * rendering into a jsdom copy of web/index.html: the three sections, the
//     symptom table, region and tract disclosures, therapies, provenance, and
//     clearKbReport hiding everything again.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (relative) => JSON.parse(readFileSync(join(root, relative), 'utf8'));
// A Node Buffer may share a pooled ArrayBuffer: copy exactly the file's bytes.
const arrayBuffer = (bytes) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
const manifest = read('web/models/manifest.json');
const kb = read('web/models/annotations/aphasia-kb.json');
const parity = read('tests/fixtures/kb-parity/kb-parity.json');

const {
  loadKnowledgeBase, reportAtlasEntries, disconnectomeEntry, measureDamage, lesionOnGrid, disconnectomeLesionNifti,
  fractionsByBundle, DisconnectomeClient, evaluateDamage, renderKbReport, clearKbReport, KB_SECTION_IDS, lesionVolumeMl, designLine,
  kbAssetId, isDraftFinding, KB_EVIDENCE,
} = await import('../web/js/modules/kb-report.js');
const { decodeNiftiBuffer } = await import('../web/js/modules/atlas-loader.js');

// --- Assets -----------------------------------------------------------------

{
  const { kb: loaded, entry } = await loadKnowledgeBase(manifest, {
    fetchBuffer: async (asset) => {
      assert.equal(asset.id, 'aphasia-kb');
      return readFileSync(join(root, 'web/models', asset.filename));
    },
  });
  assert.ok(entry.cacheKey.startsWith(`aphasia-kb-${loaded.version.contentDigest}`), 'the cache key follows the KB content digest');
  assert.equal(loaded.findings.length, kb.findings.length);
  assert.match(entry.kbSourceCommit, /^[0-9a-f]{40}$/);
  assert.ok(entry.cacheKey.endsWith(entry.checksum.replace('sha256:', '').slice(0, 12)), 'changed export bytes invalidate the browser cache');
  await assert.rejects(loadKnowledgeBase({ annotationAssets: [] }), /kbReport is missing/);

  // Two evidence levels: approved findings (the default) and approved + unreviewed drafts.
  assert.deepEqual(KB_EVIDENCE, ['approved', 'drafts']);
  assert.equal(kbAssetId(manifest, 'approved'), 'aphasia-kb');
  assert.throws(() => kbAssetId(manifest, 'everything'), /Unknown knowledge-base evidence level/);
  const noDrafts = { ...manifest, kbReport: { ...manifest.kbReport, draftsAnnotationAssetId: undefined } };
  assert.equal(kbAssetId(noDrafts, 'drafts'), null, 'a build without the drafts export offers none');
  await assert.rejects(loadKnowledgeBase(noDrafts, { evidence: 'drafts' }), /no knowledge-base export with drafts/);
  if (kbAssetId(manifest, 'drafts')) {
    const { kb: drafts, entry: draftsEntry } = await loadKnowledgeBase(manifest, {
      evidence: 'drafts',
      fetchBuffer: async (asset) => readFileSync(join(root, 'web/models', asset.filename)),
    });
    assert.equal(draftsEntry.id, 'aphasia-kb-drafts');
    assert.ok(draftsEntry.cacheKey.startsWith(`aphasia-kb-drafts-${drafts.version.contentDigest}`), 'its own cache key');
    assert.ok(drafts.version.statuses.includes('draft'));
    assert.ok(drafts.findings.length >= loaded.findings.length, 'the drafts export holds the approved findings and more');
    assert.ok(drafts.findings.some(isDraftFinding) && !loaded.findings.some(isDraftFinding), 'only the drafts export has draft findings');
  }
  assert.equal(isDraftFinding({ source_status: 'approved' }), false);
  assert.equal(isDraftFinding({}), false, 'findings without a status (older exports) count as approved');
  assert.equal(isDraftFinding({ source_status: 'draft' }), true);
  await assert.rejects(loadKnowledgeBase({ kbReport: { annotationAssetId: 'nope' }, annotationAssets: [] }), /not found/);

  const atlases = reportAtlasEntries(manifest);
  assert.deepEqual(atlases.map((a) => a.name), ['HarvardOxford', 'AAL', 'JHU', 'XTRACT']);
  const hosted = atlases.filter((a) => a.entry).map((a) => a.name);
  assert.ok(hosted.includes('HarvardOxford') && hosted.includes('AAL'), 'the cortical atlases are hosted');
  for (const { entry } of atlases.filter((a) => a.entry)) {
    assert.equal(entry.role, 'report-atlas');
    assert.ok(Object.keys(entry.labels).length >= entry.labelsPresent);
    // The static build drops NIfTI files, so a hosted atlas is fetched from a pinned, immutable URL.
    assert.match(entry.sourceUrl, /^https:\/\/(?:raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\/|huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/)/,
      `${entry.id} is fetched from a pinned URL`);
    assert.match(entry.checksum, /^sha256:[0-9a-f]{64}$/);
  }
  const disco = disconnectomeEntry(manifest);
  assert.equal(disco.entry.id, 'enigma-symmetric-tvx');
  assert.deepEqual(disco.grid.dims, [182, 218, 182]);
  assert.equal(disco.entry.bundles, 65);
  assert.match(disco.entry.sourceUrl, /huggingface\.co.+enigma_symmetric\.tvx\.gz$/);
  // Every ENIGMA bundle the mapping names exists in the atlas (golden TSV header of the engine's tests).
  const header = readFileSync(join(root, '../../exes/nii2tvx/test/expected-examples-enigma.tsv'), 'utf8').split('\n')[0].split('\t').slice(1);
  const mapped = Object.values({ ...kb.mapping.disconnectome.units, ...kb.mapping.disconnectome.extraUnits })
    .flatMap((u) => (Array.isArray(u.labels) ? u.labels : Object.values(u.labels).flat()));
  for (const bundle of mapped) assert.ok(header.includes(bundle), `${bundle} is an ENIGMA bundle`);
  assert.equal(header.length, 65);
}

// --- Measurements -----------------------------------------------------------

{
  // A 4x1x1 lesion grid at 2 mm, x = -4 + 2i (two left, two right voxels).
  const lesion = {
    data: Uint8Array.from([1, 1, 0, 1]), dims: [4, 1, 1],
    affine: [[2, 0, 0, -4], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]],
  };
  // The atlas grid is the same world span at 1 mm, offset a quarter voxel so no
  // sample sits on a nearest-neighbour tie: 8 voxels, x = -4.25 + i.
  const atlasAffine = [[1, 0, 0, -4.25], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  const onGrid = lesionOnGrid(lesion, [8, 1, 1], atlasAffine);
  assert.deepEqual(Array.from(onGrid), [1, 1, 1, 1, 0, 0, 1, 1]);
  const atlas = {
    data: Int16Array.from([5, 5, 5, 5, 5, 5, 5, 5]), dims: [8, 1, 1], header: { affine: atlasAffine },
    manifestEntry: { labels: { 5: 'Precentral Gyrus' } },
  };
  const empty = { ...atlas, data: Int16Array.from([0, 0, 0, 0, 0, 0, 0, 0]) };
  const damage = measureDamage(lesion, [{ name: 'HarvardOxford', atlas }, { name: 'AAL', atlas: empty }]);
  assert.deepEqual(damage.measured, ['HarvardOxford']);
  assert.deepEqual(damage.unmeasured, ['AAL']);
  const [row] = damage.rowsByAtlas.HarvardOxford;
  assert.equal(row.region, 'Precentral Gyrus');
  assert.equal(row.overlap_voxels, 6);
  assert.equal(row.total_lesion_voxels, 6);
  assert.equal(row.left_overlap_voxels, 4, 'x < 0 is left');
  assert.equal(row.right_overlap_voxels, 2);
  assert.deepEqual([row.left_region_voxels, row.right_region_voxels], [5, 3], 'x = -0.25 counts as left');

  const grid = manifest.kbReport.disconnectomeGrid;
  const mni = { data: new Uint8Array(160 * 160 * 192), dims: [160, 160, 192], affine: [[1, 0, 0, -79.5], [0, 1, 0, -112.5], [0, 0, 1, -79.5], [0, 0, 0, 1]] };
  // One lesion voxel at world (-40, -20, 30): i = 39.5 -> 40, j = 92.5 -> 93, k = 109.5 -> 110.
  mni.data[40 + 160 * (93 + 160 * 110)] = 1;
  const { buffer, voxels } = disconnectomeLesionNifti(mni, grid);
  assert.equal(voxels, 1);
  const decoded = await decodeNiftiBuffer(buffer);
  assert.deepEqual(decoded.dims, [182, 218, 182]);
  assert.deepEqual(decoded.header.affine[0], grid.affine[0]);
  let index = -1;
  for (let i = 0; i < decoded.data.length; i += 1) if (decoded.data[i]) { assert.equal(index, -1); index = i; }
  const [nx, ny] = decoded.dims;
  const i = index % nx; const j = Math.floor(index / nx) % ny; const k = Math.floor(index / (nx * ny));
  // FSL MNI152 1 mm: x = 90 - i, y = j - 126, z = k - 72 -> (-40.5, -19.5, 30.5) rounds to i=130, j=106, k=102.
  assert.deepEqual([i, j, k], [130, 106, 102], 'the lesion lands at its world position on the FSL grid');

  assert.deepEqual(fractionsByBundle(['a', 'b'], Float32Array.from([0.5, NaN])), { a: 0.5, b: NaN });
  // Lesion volume: voxels x |det| of the affine's 3x3 block, in mL.
  assert.ok(Math.abs(lesionVolumeMl(Uint8Array.from([1, 1, 0, 1]), [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]]) - 0.024) < 1e-12);
  assert.equal(lesionVolumeMl(new Uint8Array(10), [[-1, 0, 0, 90], [0, 1, 0, -126], [0, 0, 1, -72], [0, 0, 0, 1]]), 0);
}

// --- The disconnectome worker, in-process -----------------------------------

{
  const transcript = [];
  let client = null;
  const scope = { postMessage(message) { transcript.push(message); client?.onmessage?.({ data: message }); } };
  globalThis.self = scope;
  await import('../web/js/disconnectome-worker.js');
  class InProcessWorker {
    constructor(url, options) { this.url = url; this.options = options; this.onmessage = null; this.onerror = null; client = this; }
    postMessage(message) { queueMicrotask(() => scope.onmessage({ data: message })); }
    terminate() { client = null; }
  }
  const disconnectome = new DisconnectomeClient('js/disconnectome-worker.js?v=test', { WorkerClass: InProcessWorker });

  const exe = join(root, '../../exes/nii2tvx');
  const native = join(exe, 'nii2tvx');
  if (existsSync(native)) {
    const work = mkdtempSync(join(tmpdir(), 'calmar-kb-'));
    try {
      cpSync(join(exe, 'test/fixtures'), work, { recursive: true });
      const run = (...args) => execFileSync(native, args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] });
      run('template.nii.gz', 'all_hit.trk', 'some_hit.trk', 'none_hit.trk', 'outside.trk');
      run('-p', 'atlas.tvx', 'all_hit.tvx', 'some_hit.tvx', 'none_hit.tvx', 'outside.tvx');
      const atlasBytes = readFileSync(join(work, 'atlas.tvx'));
      let fetched = 0;
      const lesionBytes = () => arrayBuffer(readFileSync(join(exe, 'test/fixtures/lesion.nii.gz')));
      const first = await disconnectome.query(lesionBytes(), {
        atlasKey: 'fixture', atlasBytes: async () => { fetched += 1; return arrayBuffer(atlasBytes); },
      });
      assert.deepEqual(first.tracts, ['all_hit', 'some_hit', 'none_hit', 'outside']);
      const expected = readFileSync(join(exe, 'test/expected.tsv'), 'utf8').trim().split('\n')
        .find((line) => line.startsWith('lesion\t')).split('\t').slice(1).map(Number);
      for (let t = 0; t < 4; t += 1) {
        if (Number.isNaN(expected[t])) assert.ok(Number.isNaN(first.fractions[t]));
        else assert.ok(Math.abs(first.fractions[t] - expected[t]) < 1e-6, `${first.tracts[t]} ${first.fractions[t]} vs ${expected[t]}`);
      }
      const second = await disconnectome.query(lesionBytes(), {
        atlasKey: 'fixture', atlasBytes: async () => { throw new Error('the atlas must not be fetched twice'); },
      });
      assert.equal(fetched, 1, 'the opened atlas is reused');
      assert.deepEqual(Array.from(second.fractions), Array.from(first.fractions));
      const wrong = readFileSync(join(exe, 'test/fixtures/wrong_grid.nii.gz'));
      await assert.rejects(disconnectome.query(arrayBuffer(wrong), { atlasKey: 'fixture' }),
        // nii2tvx prints the mismatch over several stderr lines and the wrapper
        // keeps the last one (here the atlas's sto_xyz row), so only a refusal is asserted.
        (error) => error instanceof Error && error.message.length > 0, 'a lesion on another grid is refused');
      const byBundle = fractionsByBundle(first.tracts, first.fractions);
      assert.equal(byBundle.all_hit, 1);
      console.log('kb-report: disconnectome worker scored the nii2tvx fixtures through DisconnectomeClient.');
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  } else {
    console.log('kb-report: exes/nii2tvx not built; worker scoring skipped (make -C exes/nii2tvx).');
  }
  await assert.rejects(disconnectome.query(new ArrayBuffer(8), { atlasKey: 'never-sent' }), /atlas bytes are needed/);
  assert.ok(transcript.every((m) => typeof m.id === 'number'), 'every reply carries its request id');
  disconnectome.terminate();
  assert.equal(client, null);
}

// --- Rendering --------------------------------------------------------------

{
  const dom = new JSDOM(readFileSync(join(root, 'web/index.html'), 'utf8'));
  const { document } = dom.window;
  const cellsOf = (row) => [...row.querySelectorAll('td')].map((td) => td.textContent);
  const fixture = parity.cases.left_perisylvian;
  const fractions = Object.fromEntries(Object.entries(parity.disconnectome.arcuate_cut.fractions).map(([k, v]) => [k, v === null ? NaN : v]));
  const result = evaluateDamage(kb, fixture.input, { fractions, lesionVolumeMl: 27.3 });
  assert.ok(result.location.summaries.length && result.whiteMatter.tracts.length && result.therapy.length);
  const context = { measured: ['HarvardOxford', 'AAL', 'JHU', 'XTRACT'], unmeasured: [], missingAtlases: [], disconnectomeLabel: 'ENIGMA Symmetric tractography atlas', bundles: 65, disconnectomeNote: 'Disconnectome: ENIGMA (test).' };
  renderKbReport(document, result, { kb, context });
  for (const id of Object.values(KB_SECTION_IDS)) assert.ok(!document.getElementById(id).classList.contains('hidden'), `${id} shown`);
  for (const table of document.querySelectorAll('#resultsReport table')) {
    assert.ok(table.classList.contains('nd-data-table') && table.parentElement.classList.contains('nd-table-scroll'), 'shared table classes');
  }
  // Lesion size comes first: the measures section precedes the location section and opens with the note.
  const measuresSection = document.getElementById('kbMeasuresResults');
  assert.equal(measuresSection.nextElementSibling.id, 'kbLocationResults', 'measures are read before lesion location');
  assert.match(document.getElementById('kbMeasuresBody').firstElementChild.textContent, /^Lesion size first: this lesion is 27\.3 mL and the matched findings below concern \d+ damaged knowledge-base regions/);
  const measureRows = document.querySelectorAll('#kbMeasuresBody tr.kb-measure');
  assert.equal(measureRows.length, 1);
  assert.equal(measureRows[0].dataset.measure, 'lesion_volume');
  assert.match(cellsOf(measureRows[0])[0], /^27\.3 mL$/);
  assert.match(cellsOf(measureRows[0])[2], /^Higher values go with worse/);
  assert.equal(Number(cellsOf(measureRows[0])[3]), parity.measures.lesion_volume.distinct);
  assert.ok(document.querySelector('#kbMeasuresBody tr.kb-findings-row article.kb-finding'), 'the lesion-volume findings are reachable');
  // Every section opens with one sentence and folds its method note.
  for (const id of ['kbMeasuresBody', 'kbLocationBody', 'kbWhiteMatterBody', 'kbTherapyBody']) {
    const body = document.getElementById(id);
    assert.equal(body.firstElementChild.tagName, 'P', `${id} starts with its one-line summary`);
    assert.ok(body.querySelectorAll(':scope > p:not(.nd-report-notes)').length <= 1, `${id} has at most one prose paragraph`);
  }
  assert.equal(document.querySelectorAll('#kbLocationBody details.kb-method').length, 1, 'the method note is folded');

  // Symptom table: primary rows visible, the rest folded behind one toggle.
  const symptomRows = [...document.querySelectorAll('#kbLocationBody .kb-symptom-table tbody tr[data-target]')];
  assert.equal(symptomRows.length, result.location.summaries.length);
  assert.equal(symptomRows[0].dataset.target, result.location.summaries[0].target, 'summaries render in display-signal order');
  assert.match(symptomRows[0].querySelector('.kb-signal').textContent, /[★☆—]/, 'a display signal is drawn');
  assert.ok(!symptomRows[0].textContent.includes('(impairment)'), 'the target kind is not repeated on every row');
  const primary = result.location.summaries.filter((s) => s.primary).length;
  const secondary = result.location.summaries.length - primary;
  if (secondary) {
    assert.ok(symptomRows.slice(primary).every((row) => row.hidden), 'summaries below the criterion start folded');
    const fold = document.querySelector('#kbLocationBody .kb-symptom-table .kb-fold');
    assert.match(fold.textContent, /^Show all/);
    fold.click();
    assert.ok(symptomRows.slice(primary).every((row) => !row.hidden), 'the toggle reveals them');
    assert.match(fold.textContent, /^Show fewer/);
  }
  const cells = cellsOf;
  // Regions are anatomy labels (unit name on a side), not paper-specific entry names.
  const regionRows = [...document.querySelectorAll('#kbLocationBody tr.kb-region')];
  assert.equal(regionRows.length, result.location.regions.length);
  assert.match(cells(regionRows[0])[0], /^\d+\.\d%$/, 'lesion share leads the row');
  assert.match(cells(regionRows[0])[1], /^(Left|Right|Bilateral) /, 'regions carry their side');
  assert.ok(result.location.regions.some((r) => /^Left (angular gyrus|insula|precentral gyrus|inferior frontal gyrus)/.test(r.name)), 'single-unit regions use the unit name');
  const findingsRows = [...document.querySelectorAll('#kbLocationBody tr.kb-findings-row')];
  assert.equal(findingsRows.length, regionRows.length, 'each region row is followed by its findings row');
  assert.equal(regionRows[0].nextElementSibling, findingsRows[0]);
  const finding = findingsRows[0].querySelector('article.kb-finding');
  assert.ok(finding, 'findings render inside the folded row');
  assert.ok(finding.querySelector('code').textContent.startsWith('@'), 'citation keys are shown as keys');
  assert.match(finding.querySelector('p.nd-report-notes').textContent, /association|inverse association|no association|mixed results/);
  // v2.7: lesion-mapping findings show their design and cautions next to the claim.
  assert.ok(document.querySelector('#kbLocationBody .kb-design'), 'a Design line is shown for lesion-mapping findings');
  assert.ok(document.querySelector('#kbLocationBody .kb-design-cautions'), 'design cautions are shown');
  assert.equal(designLine({ lm_source: null }), '');
  assert.equal(designLine({ lm_source: 'inferred', lm_analysis: 'univariate', lm_n: 37, lm_correction: 'fdr', lm_orientation: 'sensitivity', lm_volume_correction: 'covariate' }),
    'univariate lesion mapping · n = 37 · FDR correction (leans sensitive) · lesion volume as a covariate — read from the stated threshold and confounders');
  const visibleRegions = regionRows.filter((row) => !row.hidden).length;
  assert.ok(visibleRegions <= result.settings.maxEvidenceRegions, 'only the main regions start visible');

  // Tracts: one table, findings rows for tracts with findings, anatomy-only rows after them.
  const tractRows = [...document.querySelectorAll('#kbWhiteMatterBody tr.kb-tract')];
  assert.equal(tractRows.length, result.whiteMatter.tracts.length + result.whiteMatter.anatomyOnly.length);
  assert.match(cells(tractRows[0])[0], /^\d+%$/, 'streamline share leads the row');
  assert.equal(document.querySelectorAll('#kbWhiteMatterBody tr.kb-findings-row').length, result.whiteMatter.tracts.length);
  assert.equal(document.querySelectorAll('#kbWhiteMatterBody tr.kb-tract-anatomy').length, result.whiteMatter.anatomyOnly.length);
  assert.ok(tractRows.some((row) => row.textContent.includes('†')), 'a shared symptom target is cross-referenced');

  // Therapies: ranked rows, impairment names (never raw ids), citation keys.
  const therapyRows = document.querySelectorAll('#kbTherapyBody tbody tr');
  assert.equal(therapyRows.length, result.therapy.length);
  assert.equal(therapyRows[0].dataset.therapy, result.therapy[0].therapy_id);
  assert.ok(!/[a-z]_[a-z]/.test(cells(therapyRows[0])[2]), `impairments are named, not ids: ${cells(therapyRows[0])[2]}`);
  const provenance = document.getElementById('kbReportProvenance');
  assert.equal(provenance.firstElementChild.tagName, 'DETAILS', 'provenance is folded');
  assert.match(provenance.textContent, /statuses: approved/);
  assert.match(provenance.textContent, /research use only, not a diagnosis/);
  assert.equal(document.querySelector('#kbLocationBody .nd-message.warning'), null, 'a left lesion gets no right-hemisphere caution');

  assert.equal(document.querySelector('#resultsReport .kb-draft-badge'), null, 'approved findings carry no draft badge');
  assert.equal(document.querySelector('#kbReportProvenance .kb-drafts-note'), null);

  // The same lesion against a knowledge base whose findings are drafts: each is marked, the provenance says so.
  const draftKb = { ...kb, version: { ...kb.version, statuses: ['approved', 'in_review', 'draft'] },
    findings: kb.findings.map((f) => ({ ...f, source_status: 'draft' })) };
  renderKbReport(document, evaluateDamage(draftKb, fixture.input, { fractions, lesionVolumeMl: 27.3 }), { kb: draftKb, context });
  const drafted = document.querySelector('#kbLocationBody article.kb-finding.kb-draft');
  assert.ok(drafted, 'draft findings are marked');
  assert.equal(drafted.querySelector('.kb-draft-badge').textContent, 'Unreviewed draft');
  assert.match(document.querySelector('#kbReportProvenance .kb-drafts-note').textContent, /includes unreviewed drafts \(statuses: approved, in_review, draft\)/);
  assert.ok(document.getElementById('kbEvidenceSelect'), 'the evidence choice is in the page');

  // Nothing matched: the sections still render their explanations.
  const nothing = evaluateDamage(kb, {}, { fractions: null });
  assert.equal(nothing.lesionSize, null);
  renderKbReport(document, nothing, { kb, context: { measured: [], unmeasured: ['HarvardOxford'], missingAtlases: ['JHU'], disconnectomeError: 'offline' } });
  assert.match(document.getElementById('kbLocationBody').textContent, /No knowledge-base findings concern the damaged regions/);
  assert.match(document.getElementById('kbMeasuresBody').textContent, /No lesion volume was available/);
  assert.match(document.getElementById('kbWhiteMatterBody').textContent, /could not be computed: offline/);
  assert.match(document.getElementById('kbTherapyBody').textContent, /No therapy entry matched/);
  assert.match(document.getElementById('kbReportProvenance').textContent, /Not hosted in this build: JHU/);

  // A right-hemisphere lesion carries the caution.
  const right = evaluateDamage(kb, parity.cases.right_small.input, { fractions: null });
  renderKbReport(document, right, { kb, context: {} });
  assert.ok(document.querySelector('#kbLocationBody .nd-message.warning'), 'the right-hemisphere caution is shown');

  clearKbReport(document);
  for (const id of Object.values(KB_SECTION_IDS)) assert.ok(document.getElementById(id).classList.contains('hidden'), `${id} hidden again`);
  assert.equal(document.getElementById('kbLocationBody').children.length, 0);
  assert.equal(document.getElementById('kbReportProvenance').children.length, 0);

  // Long atlas tables fold past the first rows; the CSV path keeps every row.
  globalThis.document = document;
  const { renderOverlapTable } = await import('../web/js/modules/overlap-render.js');
  const tableEl = document.getElementById('networkOverlapTable');
  const summary = { networks: Array.from({ length: 20 }, (_, i) => ({ network: `LH_Label_${i}`, voxelsInLesion: 20 - i, fractionOfLesion: (20 - i) / 210 })) };
  renderOverlapTable(tableEl, summary, { colormap: null });
  const rows = [...tableEl.querySelectorAll('tbody tr')];
  assert.equal(rows.length, 21, '20 label rows and one fold row');
  assert.equal(rows.filter((row) => !row.hidden && !row.classList.contains('overlap-fold-row')).length, 12);
  const fold = tableEl.querySelector('.overlap-fold');
  assert.equal(fold.textContent, 'Show all 20 labels');
  fold.click();
  assert.equal(rows.filter((row) => row.hidden).length, 0);
  assert.equal(fold.textContent, 'Show first 12 of 20 labels');
  renderOverlapTable(tableEl, { networks: summary.networks.slice(0, 5) }, { colormap: null });
  assert.equal(tableEl.querySelector('.overlap-fold'), null, 'short tables have no fold row');
  renderOverlapTable(tableEl, { networks: [{ network: 'ROI', voxelsInLesion: 20, fractionOfLesion: 0.2 }] }, { networkSizes: { ROI: 200 } });
  assert.deepEqual([...tableEl.querySelectorAll('tbody td')].map(cell => cell.textContent), ['ROI', '20', '20.0%', '10.0%']);
  assert.equal(tableEl.querySelectorAll('thead th').length, 4);
  const sortable = { networks: [
    { network: 'Large ROI', voxelsInLesion: 100, fractionOfLesion: 0.5 },
    { network: 'Small ROI', voxelsInLesion: 20, fractionOfLesion: 0.1 },
    { network: 'Unknown ROI', voxelsInLesion: 200, fractionOfLesion: 0.9 },
  ] };
  renderOverlapTable(tableEl, sortable, { networkSizes: { 'Large ROI': 1000, 'Small ROI': 25 }, maxRows: 1 });
  const header = tableEl.querySelectorAll('thead th')[3];
  header.querySelector('button').click();
  assert.equal(header.getAttribute('aria-sort'), 'descending');
  assert.equal(tableEl.querySelector('tbody td').textContent, 'Small ROI', 'sort by ROI denominator, not lesion size');
  tableEl.querySelector('.overlap-fold').click();
  header.querySelector('button').click();
  assert.equal(header.getAttribute('aria-sort'), 'ascending');
  assert.deepEqual([...tableEl.querySelectorAll('tbody tr:not(.overlap-fold-row)')].map(row => row.cells[0].textContent), ['Large ROI', 'Small ROI', 'Unknown ROI']);
  assert.equal(tableEl.querySelectorAll('tbody tr[hidden]').length, 0, 'sorting keeps expanded rows visible');
  assert.equal(sortable.networks[0].network, 'Large ROI', 'sorting does not mutate scientific output');
  assert.ok(document.getElementById('kbReportHeading').classList.contains('hidden'));
  const { mergeHarvardOxford } = await import('../web/js/modules/atlas-loader.js');
  const merged = mergeHarvardOxford(new Uint8Array([1, 1, 2, 0, 2]), new Uint8Array([0, 4, 2, 15, 14]), { 1: 'Cortex A', 2: 'Cortex B' }, { 2: 'Broad cortex', 4: 'Left Thalamus', 14: 'Ventricle', 15: 'Right Thalamus' });
  assert.deepEqual([...merged.data], [1, 52, 2, 63, 2]);
  assert.equal(merged.labels[52], 'Left Thalamus');
  assert.equal(merged.labels[50], undefined, 'broad cortex labels are excluded');
  assert.throws(() => mergeHarvardOxford([1], [], {}, {}), /lengths differ/);
  delete globalThis.document;
}

console.log('kb-report OK: assets, measurements, disconnectome worker, rendering and clearing checked.');
