// kb-evidence.js — JavaScript port of the stroke aphasia KB's evidence logic.
//
// Canonical home: github.com/micmas/stroke-aphasia-kb (js/kb-evidence.js, MIT).
// The CALMaR webapp (neurodesk/webapps, apps/calmar) vendors this file at a
// pinned commit; do not edit the vendored copy. Dependency-free on purpose:
// it runs in the browser, in Node tests and in the explorer alike.
// Reference implementation: aphasia_kb.py / aphasia_rules.py / atlas_mapping.py
// in this repository; js/test/kb-evidence.test.js checks parity against the
// fixtures export_webapp.py --fixtures writes.
//
// Knowledge-base evidence for a lesion: the JavaScript port of the parts of
// CALMaR's Python participant report that turn atlas overlap into cited
// findings. Each function names the Python it mirrors; the Node parity test
// (test/kb-evidence.test.js) replays the fixtures that
// stroke-aphasia-kb/export_webapp.py --fixtures wrote with the Python code.
//
//   unitDamage / regionDamage      stroke-aphasia-kb/atlas_mapping.py
//   disconnectionFromFractions     export_webapp.disconnection_from_fractions
//   locationFindings / interpretDamage / interpretTherapies
//                                  stroke-aphasia-kb/aphasia_kb.py (KnowledgeBase)
//   isSymptomTarget, evidenceStrength, evidenceDirection
//                                  calmar/report_evidence.py, stroke-aphasia-kb/aphasia_rules.py
//   locationReport / disconnectionReport / therapyReport
//                                  the data behind report_evidence.location_section,
//                                  disconnection_section and participant_report.therapy_table
//
// The knowledge base is the JSON written by stroke-aphasia-kb/export_webapp.py:
// { entries, findings, mapping: { units, regions, unmapped, disconnectome }, rules, citations }.
// Findings are group-level literature associations; nothing here is a
// prediction for one person, and the report copy must keep saying so.

const SIDES = ['left', 'right'];
const ABBREVIATIONS = new Set(['ifg', 'stg', 'mtg', 'itg', 'smg', 'slf', 'ilf', 'ifof', 'dlpfc', 'sma', 'ba']);
const BUCKET_ORDER = ['impairments', 'regions', 'therapies', 'predictors', 'ingredients'];
export const DIRECTION_TEXT = {
  likely: 'association', likely_responder: 'association',
  unlikely: 'inverse association', unlikely_responder: 'inverse association',
  no_effect: 'no association', mixed: 'mixed results',
};

export const DEFAULT_SETTINGS = Object.freeze({
  minOverlapPct: 5.0, minRegionPct: 25.0, minDisconnectedPct: 50.0, topN: 5,
  maxEvidenceRegions: 8, minSummaryCitations: 2, minSummaryAnatomies: 2, thinStudies: 2,
});

export function reportSettings(kb, overrides = {}) {
  return { ...DEFAULT_SETTINGS, ...(kb?.rules?.defaults || {}), ...overrides };
}

function present(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'number') return !Number.isNaN(value);
  if (typeof value === 'string' || Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

function unitLabels(unit, side) {
  const labels = unit.labels;
  if (Array.isArray(labels)) return labels.slice();
  return Array.isArray(labels?.[side]) ? labels[side].slice() : [];
}

/** All mapping units and regions, including the disconnectome-only ones. */
export function fullMapping(mapping) {
  const disco = mapping.disconnectome || {};
  return {
    units: { ...(mapping.units || {}), ...(disco.extraUnits || {}) },
    regions: { ...(mapping.regions || {}), ...(disco.extraRegions || {}) },
  };
}

// ---------------------------------------------------------------------------
// Damage per unit and knowledge-base region (atlas_mapping.py)
// ---------------------------------------------------------------------------

function sideRows(rows, labels, side, fromVoxels) {
  const hit = rows.filter((r) => labels.includes(r.region));
  if (!hit.length) return [0, null];
  if (fromVoxels) {
    const overlap = hit.reduce((n, r) => n + (Number(r[`${side}_overlap_voxels`]) || 0), 0);
    const column = `${side}_region_voxels`;
    const complete = hit.every((r) => present(r[column]));
    const size = complete ? hit.reduce((n, r) => n + Number(r[column]), 0) : null;
    return [overlap, size];
  }
  const overlap = hit.reduce((n, r) => n + (Number(r.overlap_voxels) || 0), 0);
  const size = hit.reduce((n, r) => n + (Number(r.total_region_voxels) || 0), 0);
  return [overlap, size];
}

/**
 * Damage per unit and side. ``rowsByAtlas``: { atlas: rows } where rows are
 * the lesion's overlap rows for that atlas (report-damage.js labelOverlap);
 * an atlas without rows is reported ``measured: false``, as in Python.
 */
export function unitDamage(rowsByAtlas, mapping) {
  const out = [];
  for (const [uid, unit] of Object.entries(mapping.units || {})) {
    const rows = rowsByAtlas[unit.atlas];
    const fromVoxels = Array.isArray(unit.labels);
    for (const side of SIDES) {
      if (!rows || !rows.length) {
        out.push({ unit: uid, side, atlas: unit.atlas, measured: false, overlap_voxels: 0, lesion_pct: 0, region_pct: null });
        continue;
      }
      const total = Number(rows[0].total_lesion_voxels) || 0;
      const [overlap, size] = sideRows(rows, unitLabels(unit, side), side, fromVoxels);
      out.push({
        unit: uid, side, atlas: unit.atlas, measured: true, overlap_voxels: overlap,
        lesion_pct: total ? (100 * overlap) / total : 0,
        region_pct: size ? (100 * overlap) / size : null,
      });
    }
  }
  return out;
}

/** Damage per knowledge-base region on its side (atlas_mapping.region_damage). */
export function regionDamage(units, mapping) {
  const byKey = new Map(units.map((u) => [`${u.unit}|${u.side}`, u]));
  const out = [];
  for (const [rid, region] of Object.entries(mapping.regions || {})) {
    const sides = region.side === 'both' ? SIDES : [region.side];
    const parts = [];
    for (const u of region.units || []) {
      for (const s of sides) {
        const part = byKey.get(`${u}|${s}`);
        if (part) parts.push(part);
      }
    }
    const perAtlas = [];
    for (const atlas of [...new Set(parts.map((p) => p.atlas))]) {
      const own = parts.filter((p) => p.atlas === atlas);
      const hit = own.filter((p) => p.overlap_voxels);
      const sizes = own.filter((p) => p.region_pct).map((p) => p.overlap_voxels / (p.region_pct / 100));
      const complete = own.every((p) => p.region_pct !== null || !p.overlap_voxels);
      const sumSizes = sizes.reduce((a, b) => a + b, 0);
      perAtlas.push({
        lesion_pct: own.reduce((n, p) => n + p.lesion_pct, 0),
        region_pct: hit.length && sizes.length && complete
          ? (100 * hit.reduce((n, p) => n + p.overlap_voxels, 0)) / sumSizes : null,
        measured: own.some((p) => p.measured),
      });
    }
    let best = null;
    for (const d of perAtlas) {
      if (!best) { best = d; continue; }
      const a = [d.region_pct || 0, d.lesion_pct];
      const b = [best.region_pct || 0, best.lesion_pct];
      if (a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])) best = d;
    }
    out.push({
      region: rid, side: region.side, measured: perAtlas.some((d) => d.measured),
      lesion_pct: best ? best.lesion_pct : 0, region_pct: best ? best.region_pct : null,
      units_hit: parts.filter((p) => p.overlap_voxels).map((p) => p.unit),
      review: Boolean(region.review),
    });
  }
  return out;
}

/**
 * Disconnection per knowledge-base tract region from ENIGMA streamline
 * fractions ({ bundle: fraction, NaN/null = no streamlines }), in the
 * columns of regionDamage so the same finding matching applies: region_pct
 * is the largest fraction (x100) of the region's bundles on its side.
 */
export function disconnectionFromFractions(fractions, mapping) {
  const disco = mapping.disconnectome || {};
  const units = { ...(disco.units || {}), ...(disco.extraUnits || {}) };
  const { regions } = fullMapping(mapping);
  const unitRows = new Map();
  for (const [uid, unit] of Object.entries(units)) {
    for (const side of SIDES) {
      const values = unitLabels(unit, side)
        .map((name) => fractions[name])
        .filter((v) => typeof v === 'number' && Number.isFinite(v));
      unitRows.set(`${uid}|${side}`, values.length ? Math.max(...values) * 100 : null);
    }
  }
  const out = [];
  for (const [rid, region] of Object.entries(regions)) {
    if (!(region.units || []).some((u) => u in units)) continue;
    const sides = region.side === 'both' ? SIDES : [region.side];
    const parts = [];
    for (const u of region.units) {
      for (const s of sides) {
        const value = unitRows.get(`${u}|${s}`);
        if (value !== null && value !== undefined) parts.push({ unit: u, side: s, value });
      }
    }
    if (!parts.length) continue;
    let best = parts[0];
    for (const p of parts) if (p.value > best.value) best = p;
    out.push({
      region: rid, side: region.side, measured: true, lesion_pct: 0, region_pct: best.value,
      units_hit: [best.unit], review: Boolean(region.review),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Findings for damaged regions (KnowledgeBase.location_findings / interpret_damage)
// ---------------------------------------------------------------------------

const CONFIDENCE_ORDER = { low: 0, medium: 1, high: 2 };

function weight(table, key, fallback = 1) {
  const value = table?.[key];
  return typeof value === 'number' ? value : fallback;
}

/** One row per (finding, damaged region); see KnowledgeBase.location_findings. */
export function locationFindings(kb, damage, { minOverlap = 5, minRegion = 25, minConfidence = null } = {}) {
  if (!damage?.length || !kb?.findings?.length) return [];
  const hit = new Map();
  for (const row of damage) {
    const destroyed = (row.region_pct ?? 0) >= minRegion;
    if (row.lesion_pct >= minOverlap || destroyed) hit.set(row.region, row);
  }
  if (!hit.size) return [];
  let findings = kb.findings;
  if (minConfidence) {
    const floor = CONFIDENCE_ORDER[minConfidence] ?? 0;
    findings = findings.filter((f) => (CONFIDENCE_ORDER[f.confidence] ?? 0) >= floor);
  }
  const forward = findings
    .filter((f) => f.source_kind === 'region' && hit.has(f.source_id))
    .map((f) => ({ ...f, region: f.source_id, predicts: f.target, predicts_kind: f.target_kind }));
  const reverse = findings
    .filter((f) => f.source_kind === 'impairment' && f.target_kind === 'region' && hit.has(f.target))
    .map((f) => ({ ...f, region: f.target, predicts: f.source_id, predicts_kind: 'impairment' }));
  const rules = kb.rules || {};
  return [...forward, ...reverse].map((f) => {
    const d = hit.get(f.region);
    const damageW = (d.region_pct !== null && d.region_pct !== undefined ? d.region_pct : d.lesion_pct) / 100;
    const sign = rules.directionSign?.[f.direction];
    const designW = designWeight(rules, f);
    const contribution = damageW
      * designW
      * weight(rules.strengthWeight, f.strength)
      * weight(rules.evidenceWeight, f.evidence_quality)
      * weight(rules.confidenceWeight, f.confidence)
      * (typeof sign === 'number' ? sign : 0);
    return {
      ...f, finding_id: f.id, side: d.side, lesion_pct: d.lesion_pct, region_pct: d.region_pct, design_w: designW, contribution,
    };
  });
}

/**
 * Schema v2.7 (aphasia_kb._design_weight): a lesion-mapping finding whose
 * design leaves the result less trustworthy (Moore et al. 2026) is graded
 * down. Lesion volume not controlled directly or as a covariate, and no or
 * unstated multiple-comparison correction, each multiply by the penalty;
 * findings that are not lesion mapping (no lm_source) keep 1.
 */
export function designWeight(rules, finding) {
  if (!finding || finding.lm_source === null || finding.lm_source === undefined) return 1;
  const penalty = typeof rules?.designPenalty === 'number' ? rules.designPenalty : 0.8;
  const strongVolume = rules?.designStrongVolumeControl || ['direct', 'covariate'];
  const weakCorrection = rules?.designWeakCorrection || ['uncorrected', 'not_reported'];
  let w = 1;
  if (!strongVolume.includes(finding.lm_volume_correction)) w *= penalty;
  if (weakCorrection.includes(finding.lm_correction)) w *= penalty;
  return w;
}

/** Independent evidence groups among rows: papers sharing a cohort are one group (v2.7). */
export function cohortGroupCount(rows) {
  const groups = new Set();
  for (const r of rows) {
    const label = (typeof r.cohort_group === 'string' && r.cohort_group.trim()) ? r.cohort_group.trim()
      : (typeof r.citation === 'string' && r.citation.trim()) ? r.citation.trim() : null;
    if (label) groups.add(label);
  }
  return groups.size;
}

/** locationFindings aggregated per predicted target (KnowledgeBase.interpret_damage). */
export function interpretDamage(kb, damage, options = {}) {
  const rows = locationFindings(kb, damage, options);
  if (!rows.length) return [];
  const groups = new Map();
  for (const r of rows) {
    const key = `${r.predicts}|${r.predicts_kind}`;
    if (!groups.has(key)) {
      groups.set(key, { target: r.predicts, target_kind: r.predicts_kind, score: 0, n_findings: 0, citations: new Set(), contributing_regions: new Set() });
    }
    const g = groups.get(key);
    g.score += r.contribution;
    g.n_findings += 1;
    if (typeof r.citation === 'string') g.citations.add(r.citation);
    g.contributing_regions.add(r.region);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g, citations: [...g.citations].sort(), contributing_regions: [...g.contributing_regions].sort(),
      direction: evidenceDirection(g.score),
    }))
    .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.target.localeCompare(b.target));
}

export function evidenceDirection(score) {
  return score > 0 ? 'likely' : score < 0 ? 'unlikely' : 'ambiguous';
}

/** [stars, label] display bins (aphasia_rules.evidence_strength). */
export function evidenceStrength(kb, score) {
  const bins = kb?.rules?.evidenceStrengthBins || [[0.01, 0, 'no net evidence'], [1.5, 1, 'weak / preliminary'],
    [3.0, 2, 'moderate'], [6.0, 3, 'strong'], [null, 4, 'very strong / replicated']];
  const value = Math.abs(Number(score) || 0);
  for (const [upper, stars, label] of bins) {
    if (upper === null || upper === undefined || value < upper) return [stars, label];
  }
  return [0, 'no net evidence'];
}

function squash(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z]/g, '');
}

/** aphasia_rules.canonical_aphasia_type: the canonical id for an aphasia type name, or null. */
export function canonicalAphasiaType(kb, name) {
  if (!name || !String(name).trim()) return null;
  const key = squash(name);
  for (const id of kb?.rules?.aphasiaTypes || []) {
    if (squash(id) === key) return id;
  }
  for (const [id, label] of Object.entries(kb?.rules?.aphasiaLabels || {})) {
    if (squash(label) === key || squash(`${label} aphasia`) === key) return id;
  }
  return null;
}

/** report_evidence.is_symptom_target: impairments that are symptoms, not aphasia types. */
export function isSymptomTarget(kb, target, kind) {
  if (kind !== 'impairment') return false;
  const text = String(target);
  const normalized = text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return !(canonicalAphasiaType(kb, text) !== null || normalized === 'aphasia' || normalized.endsWith('_aphasia'));
}

// ---------------------------------------------------------------------------
// Therapies (KnowledgeBase.interpret_therapies, lesion channel only)
// ---------------------------------------------------------------------------

function entriesOf(kb, bucket) {
  return Object.values(kb.entries || {}).filter((e) => e.bucket === bucket);
}

export function interpretTherapies(kb, predictedImpairmentIds, { behavioralImpairmentIds = [], maxResults = 10 } = {}) {
  const therapies = entriesOf(kb, 'therapies');
  if (!therapies.length) return [];
  const lesionSet = new Set(predictedImpairmentIds || []);
  const behavioralSet = new Set(behavioralImpairmentIds || []);
  const all = new Set([...lesionSet, ...behavioralSet]);
  const gating = behavioralSet.size > 0;
  if (!all.size) return [];
  const findings = kb.findings || [];
  const rows = [];
  for (const entry of therapies) {
    const tid = entry.id;
    const targets = Array.isArray(entry.targets_impairments) ? entry.targets_impairments : [];
    const behMatched = targets.filter((i) => behavioralSet.has(i));
    const lesMatched = targets.filter((i) => lesionSet.has(i));
    let behScore = behMatched.length * 3;
    let lesScore = lesMatched.length;
    const ch3 = findings.filter((f) => f.source_kind === 'therapy' && f.source_id === tid
      && f.target_kind === 'impairment' && all.has(f.target));
    const ch3Beh = [];
    const ch3Les = [];
    let ch3Citations = [];
    if (ch3.length) {
      for (const imp of [...new Set(ch3.map((f) => f.target).filter((t) => t !== null && t !== undefined))]) {
        if (behavioralSet.has(imp)) ch3Beh.push(imp);
        else if (lesionSet.has(imp)) ch3Les.push(imp);
      }
      ch3Citations = [...new Set(ch3.map((f) => f.citation).filter((c) => typeof c === 'string'))].sort();
      behScore += ch3Beh.length * 2;
      lesScore += ch3Les.length * 2;
    }
    const score = behScore + lesScore;
    if (!score) continue;
    const anyCitations = findings.filter((f) => f.source_kind === 'therapy' && f.source_id === tid)
      .map((f) => f.citation).filter((c) => typeof c === 'string');
    const citations = [...new Set([...ch3Citations, ...anyCitations])].sort();
    const behAll = [...new Set([...behMatched, ...ch3Beh])].sort();
    const lesAll = [...new Set([...lesMatched, ...ch3Les])].sort();
    if (gating && !behAll.length) continue;
    const ingredientIds = Array.isArray(entry.rtss_ingredients) ? entry.rtss_ingredients : [];
    const ingredients = ingredientIds.map((iid) => {
      const ingredient = kb.entries?.[iid];
      if (!ingredient || ingredient.bucket !== 'ingredients') return { id: iid, name: iid, category: '' };
      return { id: iid, name: ingredient.name || iid, category: ingredient.rtss_category || '' };
    });
    rows.push({
      therapy_id: tid, therapy_name: String(entry.name || tid), short_description: String(entry.short_description || ''),
      targets_impairments: targets, behavioral_matched: behAll, lesion_matched: lesAll,
      matched_impairments: [...new Set([...behAll, ...lesAll])].sort(), citations,
      rtss_ingredients: ingredientIds, ingredients, score,
    });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, maxResults);
}

// ---------------------------------------------------------------------------
// Names, anatomy keys, phases (report_evidence helpers)
// ---------------------------------------------------------------------------

/** KnowledgeBase.label_for: the entry name, or the id itself. */
export function labelFor(kb, id) {
  const entry = kb?.entries?.[id];
  if (entry && entry.name) return String(entry.name);
  return id;
}

/** report_evidence._name: readable name; ids without an entry are prettified. */
export function displayName(kb, id) {
  if (!id) return '';
  let name = labelFor(kb, id);
  if (name === id) {
    const words = String(id).replace(/__.*$/, '').split('_');
    name = words.map((w) => (ABBREVIATIONS.has(w) ? w.toUpperCase() : w)).join(' ');
  }
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** report_evidence._anatomy_key: regions mapped to the same units and side are one anatomy. */
export function anatomyKey(mapping, region) {
  const { regions } = fullMapping(mapping);
  const r = regions[region];
  return r ? `${[...(r.units || [])].sort().join('+')}|${r.side}` : `${region}`;
}

function lowerFirst(text) {
  const t = String(text || '');
  return t.length > 1 && t[1] === t[1].toLowerCase() ? t[0].toLowerCase() + t.slice(1) : t;
}

/**
 * The anatomical name the report shows for a knowledge-base region: for a
 * region mapped to one unit, that unit's name on its side ("Left angular
 * gyrus"); for a composite region, the entry's own name (its units would be a
 * long list). Synonymous entries (same units and side) share the label.
 */
export function anatomyLabel(kb, region) {
  const mapping = kb?.mapping || {};
  const { units, regions } = fullMapping(mapping);
  const r = regions[region];
  if (r && Array.isArray(r.units) && r.units.length === 1 && units[r.units[0]]?.name) {
    const side = r.side === 'both' ? 'Bilateral' : r.side === 'right' ? 'Right' : 'Left';
    return `${side} ${lowerFirst(units[r.units[0]].name)}`;
  }
  return displayName(kb, region);
}

/** Recovery stages a finding was studied in (export_webapp.finding_stages / report_evidence.finding_phases). */
export function findingStages(finding) {
  return Array.isArray(finding?.stages) ? finding.stages : [];
}

export function distinctFindings(rows, targetKey = null) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = [targetKey ? r[targetKey] : '', r.claim, r.citation].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

export function directionCounts(rows) {
  const counts = {
    'Associations': rows.filter((r) => r.direction === 'likely' || r.direction === 'likely_responder').length,
    'Inverse associations': rows.filter((r) => r.direction === 'unlikely' || r.direction === 'unlikely_responder').length,
    'Null findings': rows.filter((r) => r.direction === 'no_effect').length,
    'Mixed results': rows.filter((r) => r.direction === 'mixed').length,
  };
  const classified = Object.values(counts).reduce((a, b) => a + b, 0);
  if (classified < rows.length) counts['Other / unclassified'] = rows.length - classified;
  return counts;
}

function citationKeys(rows) {
  return [...new Set(rows.map((r) => r.citation).filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim()))].sort();
}

function groupBy(rows, key) {
  const groups = new Map();
  for (const r of rows) {
    const k = typeof key === 'function' ? key(r) : r[key];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

/** Symptom targets of distinct findings with how many findings name each, most first. */
function targetCounts(kb, rows) {
  const counts = new Map();
  for (const r of rows) counts.set(r.predicts, (counts.get(r.predicts) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([target, n]) => ({ target, name: displayName(kb, target), n }));
}

/** Findings grouped by outcome, each with its counts (report_evidence._claims). */
function outcomeGroupsBy(kb, rows, key) {
  return [...groupBy(rows, key).entries()].map(([target, group]) => ({
    target, name: displayName(kb, target), counts: directionCounts(group), findings: group,
  }));
}
function outcomeGroups(kb, rows) {
  return outcomeGroupsBy(kb, rows, 'predicts');
}

/** report_evidence.location_coverage: how much location evidence the lesion reaches. */
export function locationCoverage(kb, rows, damage) {
  const findings = kb.findings || [];
  const location = findings.filter((f) => f.source_kind === 'region'
    || (f.source_kind === 'impairment' && f.target_kind === 'region'));
  const mapped = kb.mapping?.regions || {};
  const unmapped = kb.mapping?.unmapped || {};
  const names = location.map((f) => (f.source_kind === 'region' ? f.source_id : f.target));
  const matched = rows ? rows.length : 0;
  return {
    findings: location.length,
    unmappable: names.filter((n) => n in unmapped).length,
    undamaged: names.filter((n) => n in mapped).length - matched,
  };
}

// ---------------------------------------------------------------------------
// Report data (what the HTML sections show)
// ---------------------------------------------------------------------------

/**
 * The lesion-location section's data (report_evidence.location_section):
 * symptom summaries ranked by display signal, and one block per damaged
 * anatomy with its distinct findings grouped by outcome.
 */
export function locationReport(kb, rows, damage, settings = reportSettings(kb)) {
  const mapping = kb.mapping || {};
  const matchedBeforeFilter = rows ? rows.length : 0;
  const symptomRows = (rows || []).filter((r) => isSymptomTarget(kb, r.predicts, r.predicts_kind))
    .map((r) => ({ ...r, target_name: displayName(kb, r.predicts), region_name: displayName(kb, r.region), anatomy: anatomyKey(mapping, r.region) }));
  const coverage = locationCoverage(kb, rows, damage);
  const measuredAtlases = [...new Set((damage || []).filter((d) => d.measured).flatMap((d) => d.units_hit || []))];
  const base = { coverage, matchedBeforeFilter, shown: symptomRows.length, measuredAtlases, settings, summaries: [], regions: [], laterality: lateralityNote(damage) };
  if (!symptomRows.length) return base;
  // One name per anatomy (anatomyLabel); the KB entries behind it are listed as synonyms.
  const names = new Map();
  for (const [key, group] of groupBy(symptomRows, 'anatomy')) {
    const counts = new Map();
    for (const r of group) counts.set(r.region_name, (counts.get(r.region_name) || 0) + 1);
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const label = anatomyLabel(kb, group[0].region);
    names.set(key, [label, ...entries.filter((n) => n !== label)]);
  }
  for (const r of symptomRows) r.region_name = names.get(r.anatomy)[0];
  const shareOf = new Map();
  for (const r of symptomRows) shareOf.set(r.region_name, Math.max(shareOf.get(r.region_name) || 0, r.lesion_pct || 0));

  const summaries = [];
  for (const [target, g] of groupBy(symptomRows, 'predicts')) {
    const score = g.reduce((n, r) => n + r.contribution, 0);
    const shown = distinctFindings(g, 'predicts');
    const regions = [...new Set(g.map((r) => r.region_name))].sort((a, b) => (shareOf.get(b) || 0) - (shareOf.get(a) || 0) || a.localeCompare(b));
    const citations = citationKeys(shown);
    const groups = cohortGroupCount(shown) || citations.length;
    const anatomies = new Set(g.map((r) => r.anatomy)).size;
    const [stars, label] = evidenceStrength(kb, score);
    summaries.push({
      target, name: g[0].target_name, kind: g[0].predicts_kind, score, stars, strengthLabel: label,
      distinct: shown.length, counts: directionCounts(shown), regions, citations, groups, anatomies,
      // v2.7: papers sharing a cohort are one evidence group, not independent replications.
      primary: groups >= Math.max(1, settings.minSummaryCitations) && anatomies >= Math.max(1, settings.minSummaryAnatomies),
    });
  }
  summaries.sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

  const review = new Map((damage || []).map((d) => [d.region, Boolean(d.review)]));
  const ranked = [...groupBy(symptomRows, 'anatomy').entries()].map(([key, g]) => ({
    key, g,
    lesion: Math.max(...g.map((r) => r.lesion_pct || 0)),
    region: Math.max(...g.map((r) => r.region_pct || 0)),
  })).sort((a, b) => b.lesion - a.lesion || b.region - a.region);
  const regions = ranked.map(({ key, g }) => {
    const shown = distinctFindings(g, 'predicts');
    const first = g[0];
    const studies = new Set(g.map((r) => r.citation).filter((c) => c !== null && c !== undefined)).size;
    return {
      key, region: first.region, name: names.get(key)[0], synonyms: names.get(key).slice(1), side: first.side,
      lesion_pct: first.lesion_pct, region_pct: first.region_pct, distinct: shown.length,
      judgementCall: [...new Set(g.map((r) => r.region))].some((rid) => review.get(rid)),
      thin: studies <= settings.thinStudies ? studies : null,
      targets: targetCounts(kb, shown),
      outcomes: outcomeGroups(kb, shown),
    };
  });
  return { ...base, summaries, regions };
}

/** report_evidence.laterality_note: true when the lesion lies mainly in the right hemisphere. */
export function lateralityNote(damage) {
  let left = 0;
  let right = 0;
  for (const d of damage || []) {
    if (d.side === 'left') left = Math.max(left, d.lesion_pct || 0);
    if (d.side === 'right') right = Math.max(right, d.lesion_pct || 0);
  }
  return { left, right, mainlyRight: right > 0 && right > 2 * left };
}

/**
 * The white-matter disconnection section's data (report_evidence.disconnection_section):
 * tracts over the threshold with their symptom findings, plus tracts over the
 * threshold with no eligible finding (anatomical context only), and the
 * symptom targets shared with the direct-damage section.
 */
export function disconnectionReport(kb, rows, disconnection, damage, settings = reportSettings(kb), { lesionRows = [] } = {}) {
  const mapping = kb.mapping || {};
  const matchedBeforeFilter = rows ? rows.length : 0;
  const measured = (disconnection || []).filter((d) => d.measured && typeof d.region_pct === 'number');
  const qualifying = measured.filter((d) => d.region_pct >= settings.minDisconnectedPct)
    .map((d) => ({ ...d, anatomy: anatomyKey(mapping, d.region) }));
  const symptomRows = (rows || []).filter((r) => isSymptomTarget(kb, r.predicts, r.predicts_kind))
    .map((r) => ({ ...r, target_name: displayName(kb, r.predicts), region_name: displayName(kb, r.region), anatomy: anatomyKey(mapping, r.region) }));
  const direct = new Map();
  for (const d of damage || []) {
    if (typeof d.region_pct === 'number') direct.set(d.region, Math.max(direct.get(d.region) ?? -Infinity, d.region_pct));
  }
  const evidenceAnatomies = new Set(symptomRows.map((r) => r.anatomy));
  const anatomyOnly = [];
  const byAnatomy = groupBy(qualifying, 'anatomy');
  const rankedKeys = [...byAnatomy.entries()].map(([key, g]) => [key, Math.max(...g.map((d) => d.region_pct))])
    .sort((a, b) => b[1] - a[1]).map(([key]) => key);
  for (const key of rankedKeys) {
    if (evidenceAnatomies.has(key)) continue;
    const group = byAnatomy.get(key);
    const first = group.reduce((best, d) => (d.region_pct > best.region_pct ? d : best), group[0]);
    const label = anatomyLabel(kb, first.region);
    const names = [label, ...[...new Set(group.map((d) => displayName(kb, d.region)))].filter((n) => n !== label)];
    const destroyed = Math.max(-Infinity, ...group.map((d) => direct.get(d.region)).filter((v) => typeof v === 'number'));
    anatomyOnly.push({
      key, region: first.region, name: names[0], synonyms: names.slice(1), side: first.side, region_pct: first.region_pct,
      directlyDamagedPct: Number.isFinite(destroyed) && destroyed > 0 ? destroyed : null,
    });
  }
  let message = null;
  if (!symptomRows.length) {
    if (matchedBeforeFilter) {
      message = 'Disconnectome-matched tracts were found, but their knowledge-base records contain no symptom-level targets eligible for this report. Their anatomical disconnection is still listed below.';
    } else if (!measured.length) {
      message = 'No tract-disconnection measurements were available for this map.';
    } else if (!qualifying.length) {
      message = 'No mapped tract reached the disconnection threshold.';
    } else {
      message = 'No symptom-level knowledge-base findings matched these tracts. Their map-derived disconnection is still listed below as anatomical context.';
    }
    return { matchedBeforeFilter, measured: measured.length, qualifying: qualifying.length, message, tracts: [], anatomyOnly, settings };
  }
  const lesionSymptom = (lesionRows || []).filter((r) => isSymptomTarget(kb, r.predicts, r.predicts_kind))
    .map((r) => ({ ...r, anatomy: anatomyKey(mapping, r.region) }));
  const names = new Map();
  for (const [key, group] of groupBy(symptomRows, 'anatomy')) {
    const counts = new Map();
    for (const r of group) counts.set(r.region_name, (counts.get(r.region_name) || 0) + 1);
    const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n);
    const label = anatomyLabel(kb, group[0].region);
    names.set(key, [label, ...entries.filter((n) => n !== label)]);
  }
  const tracts = [...groupBy(symptomRows, 'anatomy').entries()]
    .map(([key, g]) => [key, g, Math.max(...g.map((r) => r.region_pct || 0))])
    .sort((a, b) => b[2] - a[2])
    .map(([key, g]) => {
      const shown = distinctFindings(g, 'predicts');
      const first = g[0];
      const destroyed = Math.max(-Infinity, ...[...new Set(g.map((r) => r.region))].map((rid) => direct.get(rid)).filter((v) => typeof v === 'number'));
      const studies = new Set(g.map((r) => r.citation).filter((c) => c !== null && c !== undefined)).size;
      const shared = [];
      for (const target of [...new Set(g.map((r) => r.predicts))].sort((a, b) => displayName(kb, a).toLowerCase().localeCompare(displayName(kb, b).toLowerCase()))) {
        const elsewhere = lesionSymptom.filter((r) => r.predicts === target && r.anatomy !== key);
        if (!elsewhere.length) continue;
        shared.push({
          target, name: displayName(kb, target),
          tractCounts: directionCounts(distinctFindings(g.filter((r) => r.predicts === target), 'predicts')),
          directCounts: directionCounts(distinctFindings(elsewhere, 'predicts')),
        });
      }
      return {
        key, region: first.region, name: names.get(key)[0], synonyms: names.get(key).slice(1), side: first.side,
        region_pct: first.region_pct, distinct: shown.length, counts: directionCounts(shown),
        directlyDamagedPct: Number.isFinite(destroyed) && destroyed > 0 ? destroyed : null,
        thin: studies <= settings.thinStudies ? studies : null, shared,
        targets: targetCounts(kb, shown),
        outcomes: outcomeGroups(kb, shown),
      };
    });
  return { matchedBeforeFilter, measured: measured.length, qualifying: qualifying.length, message: null, tracts, anatomyOnly, settings };
}

/**
 * Therapy rows for the report (participant_report.therapy_table): the
 * matched impairments by name and a stage note when the therapy's evidence
 * was studied in another recovery stage than the participant's (only when a
 * stage is known).
 */
export function therapyReport(kb, therapies, { stage = null } = {}) {
  const stages = kb.rules?.therapyEvidenceStages || {};
  return (therapies || []).map((t) => {
    const evidence = stages[t.therapy_id] || [];
    const mismatch = stage && evidence.length && !evidence.includes(stage)
      ? `Evidence for this therapy comes from ${evidence.join(' / ')} patients; the current recovery stage is ${stage}.` : null;
    return {
      ...t,
      behavioral_names: t.behavioral_matched.map((i) => displayName(kb, i)),
      lesion_names: t.lesion_matched.map((i) => displayName(kb, i)),
      evidenceStages: evidence, stageMismatch: mismatch,
    };
  });
}

/**
 * The measures section's data (report_evidence.measures_section) for the
 * measures the webapp has: one card per measure with the findings stored on
 * its predictor entry (those whose target is not the measure itself), the
 * entry's direction of severity and the relationship counts. ``measures`` is
 * { predictorId: value } (lesion_volume in mL).
 */
export function measuresReport(kb, measures) {
  const findings = (kb.findings || []).filter((f) => f.source_kind === 'predictor');
  const out = [];
  for (const [pid, value] of Object.entries(measures || {})) {
    const entry = kb.entries?.[pid];
    const g = findings.filter((f) => f.source_id === pid && f.target !== pid)
      .map((f) => ({ ...f, finding_id: f.id, target_name: displayName(kb, f.target) }));
    if (!g.length) continue;
    const shown = distinctFindings(g);
    const polarity = {
      higher_is_worse: 'higher values go with worse language or recovery',
      lower_is_worse: 'lower values go with worse language or recovery',
    }[entry?.direction_of_severity] || null;
    const counts = {};
    for (const r of shown) {
      const d = r.direction || 'not reported';
      counts[d] = (counts[d] || 0) + 1;
    }
    out.push({
      id: pid, name: { lesion_volume: 'Lesion volume' }[pid] || displayName(kb, pid), value, units: entry?.units || null,
      polarity, distinct: shown.length, directionCounts: counts, groups: cohortGroupCount(shown),
      outcomes: outcomeGroupsBy(kb, shown, 'target'),
    });
  }
  return out;
}

/** report_evidence.lesion_size_note's data: the volume and how many regions the findings concern. */
export function lesionSizeNote(volumeMl, rows) {
  if (volumeMl === null || volumeMl === undefined || volumeMl === '') return null;
  const volume = Number(volumeMl);
  if (!Number.isFinite(volume)) return null;
  return { volumeMl: volume, regions: new Set((rows || []).map((r) => r.region)).size };
}

/** The symptom-level impairments a lesion points to, in display order (participant_report, step 3). */
export function predictedSymptomImpairments(kb, imaging, topN = 5) {
  return imaging.filter((r) => isSymptomTarget(kb, r.target, r.target_kind)).map((r) => r.target).slice(0, topN * 2);
}

/**
 * Everything the webapp report shows for a lesion, from the damage and
 * disconnection tables: the three sections' data plus the inputs they used.
 */
export function evaluateLesion(kb, { damage, disconnection = null, settings = reportSettings(kb), stage = null, lesionVolumeMl = null } = {}) {
  const options = { minOverlap: settings.minOverlapPct, minRegion: settings.minRegionPct };
  const rows = locationFindings(kb, damage, options);
  const measures = measuresReport(kb, lesionVolumeMl === null || lesionVolumeMl === undefined ? {} : { lesion_volume: lesionVolumeMl });
  const imaging = interpretDamage(kb, damage, options);
  const impairments = predictedSymptomImpairments(kb, imaging, settings.topN);
  const therapies = interpretTherapies(kb, impairments, { maxResults: settings.topN });
  const disconnectionRows = disconnection
    ? locationFindings(kb, disconnection, { minOverlap: 101, minRegion: settings.minDisconnectedPct }) : null;
  return {
    settings, stage, damage, rows, imaging, impairments, therapies, disconnection, disconnectionRows,
    lesionVolumeMl, measures, lesionSize: lesionSizeNote(lesionVolumeMl, rows),
    location: locationReport(kb, rows, damage, settings),
    whiteMatter: disconnection ? disconnectionReport(kb, disconnectionRows, disconnection, damage, settings, { lesionRows: rows }) : null,
    therapy: therapyReport(kb, therapies, { stage }),
  };
}
