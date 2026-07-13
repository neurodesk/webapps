#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');

function makeElement(tagName) {
  let text = '';
  return {
    tagName,
    children: [],
    style: {},
    className: '',
    colSpan: 0,
    innerHTML: '',
    appendChild(child) { this.children.push(child); },
    set textContent(value) { text = String(value); },
    get textContent() { return text; }
  };
}

(async () => {
  const {
    rankFunctionalTerms,
    renderFunctionalProfileTable
  } = await import(pathToFileURL(path.join(ROOT, 'web/js/modules/function-profiles.js')));

  const assetPath = path.join(ROOT, 'web/models/annotations/yeo7_function_profiles.json');
  const asset = JSON.parse(fs.readFileSync(assetPath, 'utf8'));
  assert.equal(asset.id, 'yeo7-neurosynth-v7-function-profiles',
    'committed profile asset must expose the manifest id');
  for (const network of ['Visual', 'Somatomotor', 'DorsalAttention', 'VentralAttention', 'Limbic', 'Frontoparietal', 'Default']) {
    assert.ok(Array.isArray(asset.networkProfiles[network]) && asset.networkProfiles[network].length > 0,
      `committed profile asset must include terms for ${network}`);
  }

  const schaeferAssetPath = path.join(ROOT, 'web/models/annotations/schaefer400_function_profiles.json');
  const schaeferAsset = JSON.parse(fs.readFileSync(schaeferAssetPath, 'utf8'));
  assert.equal(schaeferAsset.id, 'schaefer400-neurosynth-v7-function-profiles',
    'committed Schaefer profile asset must expose the manifest id');
  assert.equal(schaeferAsset.method, 'NiMARE ROIAssociationDecoder',
    'Schaefer profile asset must come from a parcel-wise NiMARE ROI decoder');
  assert.equal(schaeferAsset.sourceLabel, 'Neurosynth v7 via NiMARE (parcel-wise Schaefer ROI decode)',
    'Schaefer profile asset must expose parcel-wise source copy');
  assert.equal(schaeferAsset.topTermsPerParcel, 24,
    'Schaefer profile asset must pin its top-term depth');
  assert.equal(schaeferAsset.minimumSourceScore, 0.01,
    'Schaefer profile asset must pin the source-score filter');
  assert.equal(schaeferAsset.parcelProfileCount, 400,
    'Schaefer profile asset must include all 400 parcel labels');
  assert.equal(Object.keys(schaeferAsset.networkProfiles || {}).length, 400,
    'Schaefer profile asset must key profiles by Schaefer parcel label');
  assert.ok(Object.keys(schaeferAsset.networkProfiles).every(label => !label.startsWith('7Networks_')),
    'Schaefer profile labels must omit the 7Networks_ display prefix');
  const firstSchaeferParcelTerms = schaeferAsset.networkProfiles.LH_Vis_1;
  assert.ok(Array.isArray(firstSchaeferParcelTerms),
    'Schaefer profile asset must include parcel-label keyed terms');
  assert.equal(firstSchaeferParcelTerms.length, 24,
    'Schaefer profile asset must include 24 terms for each decoded parcel');
  assert.equal(firstSchaeferParcelTerms[0].term, 'fusiform',
    'Schaefer profile terms must come from parcel-wise ROI decode output');
  assert.ok(firstSchaeferParcelTerms.every(term => !('sourceNetwork' in term)),
    'Schaefer parcel-wise terms must not retain inherited Yeo-network provenance');
  assert.ok(firstSchaeferParcelTerms.every(term => !/terms abstract tfidf/i.test(term.term)),
    'Schaefer profile terms must strip NiMARE feature prefixes before rendering');

  const profiles = {
    sourceLabel: 'Neurosynth v7 via NiMARE',
    networkProfiles: {
      Visual: [
        { term: 'visual', score: 0.8 },
        { term: 'attention', score: 0.2 }
      ],
      Default: [
        { term: 'memory', score: 0.7 },
        { term: 'attention', score: 0.6 }
      ],
      Somatomotor: [
        { term: 'motor', score: 0.9 }
      ]
    }
  };

  const summary = {
    networks: [
      { network: 'Visual', fractionOfLesion: 0.5 },
      { network: 'Default', fractionOfLesion: 0.25 },
      { network: 'Unassigned', fractionOfLesion: 0.25 },
      { network: 'MissingProfile', fractionOfLesion: 0.4 }
    ]
  };

  const ranked = rankFunctionalTerms(summary, profiles, { topN: 4, minScore: 0.01 });
  assert.deepEqual(
    ranked.map(row => [row.term, Number(row.score.toFixed(3))]),
    [
      ['visual', 0.4],
      ['attention', 0.25],
      ['memory', 0.175]
    ],
    'ranking must weight profiles by network fractions, combine duplicate terms, and skip missing/Unassigned networks'
  );
  assert.deepEqual(
    ranked[1].contributors.map(c => [c.network, Number(c.contribution.toFixed(3))]),
    [['Default', 0.15], ['Visual', 0.1]],
    'combined duplicate terms must retain strongest network contributors'
  );

  const truncated = rankFunctionalTerms(summary, profiles, { topN: 1, minScore: 0.01 });
  assert.equal(truncated.length, 1, 'topN must truncate ranked terms');
  assert.equal(truncated[0].term, 'visual');

  const filtered = rankFunctionalTerms(summary, profiles, { topN: 8, minScore: 0.3 });
  assert.deepEqual(filtered.map(row => row.term), ['visual'],
    'minScore must filter weak weighted terms');

  const zero = rankFunctionalTerms({ networks: [{ network: 'Visual', fractionOfLesion: 0 }] }, profiles);
  assert.deepEqual(zero, [], 'zero network weights must produce no terms');

  const schaeferRanked = rankFunctionalTerms({
    networks: [
      { network: 'LH_Vis_1', fractionOfLesion: 0.5 },
      { network: 'LH_Default_Temp_1', fractionOfLesion: 0.5 }
    ]
  }, schaeferAsset, { topN: 4, minScore: 0.01 });
  assert.ok(schaeferRanked.length > 0,
    'Schaefer parcel-keyed profiles must rank terms for direct parcel labels');
  assert.equal(schaeferRanked[0].term, 'fusiform',
    'Schaefer parcel-keyed profiles must use parcel-wise ROI decode terms');
  assert.ok(schaeferRanked.some(row => row.contributors[0].network.startsWith('LH_')),
    'Schaefer ranked terms must report cleaned parcel labels as contributors');
  assert.ok(schaeferRanked.every(row => row.contributors.every(item => !item.network.startsWith('7Networks_'))),
    'Schaefer ranked contributors must omit the 7Networks_ display prefix');

  const originalDocument = global.document;
  global.document = { createElement: makeElement };
  try {
    const table = makeElement('table');
    renderFunctionalProfileTable(table, ranked, { sourceLabel: profiles.sourceLabel });
    assert.equal(table.children[0].tagName, 'caption');
    assert.equal(table.children[0].textContent, 'Neurosynth v7 via NiMARE',
      'renderer must surface the source label');
    const body = table.children.find(child => child.tagName === 'tbody');
    assert.ok(body, 'renderer must append a tbody');
    assert.equal(body.children.length, 3, 'renderer must append one row per ranked term');
    assert.equal(body.children[0].children[2].textContent, 'Visual',
      'single-network driver labels must not duplicate the numeric score');
    assert.equal(body.children[1].children[2].textContent, 'Default; Visual',
      'multi-network driver labels must list contributing networks without score repetition');

    const schaeferTable = makeElement('table');
    renderFunctionalProfileTable(schaeferTable, schaeferRanked, {
      sourceLabel: schaeferAsset.sourceLabel,
      driverHeader: 'Atlas label drivers'
    });
    const schaeferHeader = schaeferTable.children
      .find(child => child.tagName === 'thead')
      .children[0].children[2].textContent;
    assert.equal(schaeferHeader, 'Atlas label drivers',
      'renderer must allow parcel-based atlas label driver copy');

    const emptyTable = makeElement('table');
    renderFunctionalProfileTable(emptyTable, [], { emptyLabel: 'No terms' });
    const emptyBody = emptyTable.children.find(child => child.tagName === 'tbody');
    assert.equal(emptyBody.children[0].children[0].textContent, 'No terms',
      'renderer must show an empty-state row');
  } finally {
    global.document = originalDocument;
  }

  console.log('function-profiles OK: ranking, duplicate-term merge, filtering, rendering.');
})();
