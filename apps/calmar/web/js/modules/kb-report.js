// Knowledge-base report for the Results view: the browser side of the
// evidence port in packages/calmar/src/kb-evidence.js.
//
// Pipeline stage `kb-report` (orchestrator.runKbReport):
//   1. loadKnowledgeBase()        the aphasia-kb JSON (manifest annotation asset)
//   2. reportAtlasEntries()       which of the mapping's label atlases are hosted
//   3. measureDamage()            warped lesion -> each atlas grid -> labelOverlap rows
//   4. DisconnectomeClient        lesion on the MNI152 1 mm grid -> ENIGMA bundle fractions
//   5. evaluateLesion()           findings, summaries, tracts, therapies (shared package)
//   6. renderKbReport()           three sections in #resultsReport
//
// Everything rendered is a group-level literature association with its
// citation and review provenance. The copy says so wherever a reader could
// mistake it for a prediction about the person on the screen; keep it that way.
import { fetchCacheFirst, loadAtlasFromManifest } from './atlas-loader.js';
import { resampleAffine } from './resample.js';
import { writeNifti1 } from './nifti-writer.js';
import { labelOverlap } from './report-damage.js';
import {
  unitDamage, regionDamage, disconnectionFromFractions, evaluateLesion, reportSettings, DIRECTION_TEXT,
} from './kb-evidence.js';

const KB_CACHE = 'lnm-assets-v1';
const SECTION_IDS = {
  measures: 'kbMeasuresResults', location: 'kbLocationResults', whiteMatter: 'kbWhiteMatterResults', therapy: 'kbTherapyResults',
  provenance: 'kbReportProvenance',
};
const BODY_IDS = { measures: 'kbMeasuresBody', location: 'kbLocationBody', whiteMatter: 'kbWhiteMatterBody', therapy: 'kbTherapyBody' };

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export function kbReportConfig(manifest) {
  const config = manifest?.kbReport;
  if (!config || !config.annotationAssetId) throw new Error('manifest.kbReport is missing');
  return config;
}

/** Evidence levels the report offers: approved findings only, or approved + unreviewed drafts. */
export const KB_EVIDENCE = ['approved', 'drafts'];

/**
 * The annotation asset id for an evidence level: manifest.kbReport.annotationAssetId
 * (approved findings) or manifest.kbReport.draftsAnnotationAssetId (approved +
 * unreviewed drafts; null when this build hosts no drafts export).
 */
export function kbAssetId(manifest, evidence = 'approved') {
  const config = kbReportConfig(manifest);
  if (evidence === 'approved') return config.annotationAssetId;
  if (evidence !== 'drafts') throw new Error(`Unknown knowledge-base evidence level: ${evidence}`);
  const id = config.draftsAnnotationAssetId;
  const hosted = id && (manifest.annotationAssets || []).some((a) => a.id === id && a.supportStatus === 'supported');
  return hosted ? id : null;
}

/** The knowledge base JSON for an evidence level (default: approved findings), Cache Storage first. */
export async function loadKnowledgeBase(manifest, { fetchBuffer = null, evidence = 'approved', signal } = {}) {
  const config = kbReportConfig(manifest);
  const assetId = kbAssetId(manifest, evidence);
  if (!assetId) throw new Error('This build hosts no knowledge-base export with drafts');
  const entry = (manifest.annotationAssets || []).find((a) => a.id === assetId);
  if (!entry) throw new Error(`Knowledge-base asset not found: ${assetId || config.annotationAssetId}`);
  if (entry.supportStatus !== 'supported') throw new Error(`Knowledge-base asset is not supported: ${entry.id}`);
  let buffer;
  if (fetchBuffer) {
    buffer = await fetchBuffer(entry);
  } else {
    const cache = typeof caches !== 'undefined' ? await caches.open(KB_CACHE) : null;
    buffer = await fetchCacheFirst(entry.sourceUrl, entry.cacheKey, cache, { signal });
  }
  const kb = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer)));
  if (kb.schemaVersion !== 1) throw new Error(`Unsupported knowledge-base schema ${kb.schemaVersion}`);
  return { kb, entry };
}

/**
 * The mapping's label atlases: `{ name, assetId, entry }` for every name in
 * manifest.kbReport.reportAtlases, with `entry` null when the asset is not
 * hosted (the report then says the atlas was not measured).
 */
export function reportAtlasEntries(manifest) {
  const config = kbReportConfig(manifest);
  return Object.entries(config.reportAtlases || {}).map(([name, assetId]) => {
    const entry = (manifest.atlasAssets || []).find((a) => a.id === assetId && a.supportStatus === 'supported') || null;
    return { name, assetId, entry };
  });
}

export function disconnectomeEntry(manifest) {
  const config = kbReportConfig(manifest);
  const entry = (manifest.atlasAssets || []).find((a) => a.id === config.disconnectomeAssetId && a.supportStatus === 'supported');
  return entry ? { entry, grid: config.disconnectomeGrid } : null;
}

// ---------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------

/** Nearest-neighbour copy of a binary lesion onto another grid (both affines voxel -> world). */
export function lesionOnGrid(lesion, dims, affine) {
  const mask = lesion.data instanceof Uint8Array ? lesion.data : Uint8Array.from(lesion.data, (v) => (v > 0 ? 1 : 0));
  const out = resampleAffine(mask, lesion.dims, lesion.affine, dims, affine, 'nearest');
  return out instanceof Uint8Array ? out : Uint8Array.from(out, (v) => (v > 0 ? 1 : 0));
}

/**
 * Overlap rows per atlas name for the knowledge-base mapping. `atlases` are
 * `{ name, atlas }` with `atlas` from loadAtlasFromManifest (data, dims,
 * header.affine, manifestEntry.labels). Atlases the lesion does not touch
 * produce no rows and count as unmeasured, as in the Python report.
 */
export function measureDamage(lesion, atlases) {
  const rowsByAtlas = {};
  const measured = [];
  const unmeasured = [];
  const perAtlas = {};
  for (const { name, atlas } of atlases) {
    const affine = atlas.header.affine;
    const onGrid = lesionOnGrid(lesion, atlas.dims, affine);
    const { rows, totalLesionVoxels } = labelOverlap({
      lesion: onGrid, atlas: atlas.data, dims: atlas.dims, affine, labels: atlas.manifestEntry?.labels || {},
    });
    perAtlas[name] = { rows: rows.length, totalLesionVoxels };
    if (rows.length) {
      rowsByAtlas[name] = rows;
      measured.push(name);
    } else {
      unmeasured.push(name);
    }
  }
  return { rowsByAtlas, measured, unmeasured, perAtlas };
}

/** Binary NIfTI of the lesion on the disconnectome atlas grid (FSL MNI152 1 mm). */
export function disconnectomeLesionNifti(lesion, grid) {
  const dims = grid.dims;
  const affine = grid.affine;
  const mask = lesionOnGrid(lesion, dims, affine);
  let voxels = 0;
  for (let i = 0; i < mask.length; i += 1) voxels += mask[i];
  const nifti = writeNifti1(mask, {
    dims, spacing: [1, 1, 1], affine: [affine[0], affine[1], affine[2]].flat(),
    description: 'CALMaR lesion on the MNI152 1mm disconnectome grid',
  });
  return { buffer: nifti, voxels };
}

export function fractionsByBundle(tracts, fractions) {
  const out = {};
  for (let i = 0; i < tracts.length; i += 1) out[tracts[i]] = fractions[i];
  return out;
}

/** Talks to web/js/disconnectome-worker.js; keeps the atlas open across queries. */
export class DisconnectomeClient {
  constructor(workerUrl, { WorkerClass = globalThis.Worker } = {}) {
    this.workerUrl = workerUrl;
    this.WorkerClass = WorkerClass;
    this.worker = null;
    this.pending = new Map();
    this.nextId = 1;
    this.sentAtlasKeys = new Set();
  }

  ensureWorker() {
    if (this.worker) return this.worker;
    this.worker = new this.WorkerClass(this.workerUrl, { type: 'module' });
    this.worker.onmessage = ({ data }) => {
      const waiting = this.pending.get(data?.id);
      if (!waiting) return;
      this.pending.delete(data.id);
      if (data.type === 'error') waiting.reject(new Error(data.message));
      else waiting.resolve(data);
    };
    this.worker.onerror = (event) => {
      const error = new Error(event?.message || 'disconnectome worker failed');
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
      this.terminate();
    };
    return this.worker;
  }

  /** `{ tracts, fractions }` for a lesion NIfTI; `atlasBytes()` is called only for the first query. */
  async query(lesionBuffer, { atlasKey, atlasBytes }) {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    // Register before downloading: cancellation must settle this promise too.
    void (async () => {
      try {
        const message = { id, type: 'query', atlasKey, lesion: lesionBuffer };
        const transfer = [lesionBuffer];
        if (!this.sentAtlasKeys.has(atlasKey)) {
          if (typeof atlasBytes !== 'function') throw new Error(`disconnectome: the atlas bytes are needed for the first query of ${atlasKey}`);
          const atlas = await atlasBytes();
          message.atlas = atlas.slice(0);
          transfer.push(message.atlas);
        }
        if (!this.pending.has(id) || worker !== this.worker) return;
        worker.postMessage(message, transfer);
      } catch (error) {
        this.pending.get(id)?.reject(error);
        this.pending.delete(id);
      }
    })();
    const data = await result;
    if (worker !== this.worker) throw new DOMException('Disconnectome cancelled', 'AbortError');
    this.sentAtlasKeys.add(atlasKey);
    return { tracts: data.tracts, fractions: data.fractions };
  }

  terminate() {
    this.worker?.terminate();
    this.worker = null;
    this.sentAtlasKeys.clear();
    for (const waiting of this.pending.values()) waiting.reject(new DOMException('Disconnectome cancelled', 'AbortError'));
    this.pending.clear();
  }
}

/**
 * The whole evaluation from decoded lesion + loaded assets; the orchestrator
 * owns the async loading so it can check the results generation between awaits.
 */
export function evaluateDamage(kb, rowsByAtlas, { fractions = null, settings = null, lesionVolumeMl = null } = {}) {
  const resolved = settings || reportSettings(kb);
  const damage = regionDamage(unitDamage(rowsByAtlas, kb.mapping), kb.mapping);
  const disconnection = fractions ? disconnectionFromFractions(fractions, kb.mapping) : null;
  return evaluateLesion(kb, { damage, disconnection, settings: resolved, lesionVolumeMl });
}

/** Lesion volume in mL from a binary mask and its voxel -> world affine (|det| of the 3x3 block). */
export function lesionVolumeMl(mask, affine) {
  const m = affine;
  const det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  let voxels = 0;
  for (let i = 0; i < mask.length; i += 1) if (mask[i]) voxels += 1;
  return (voxels * Math.abs(det)) / 1000;
}

// ---------------------------------------------------------------------------
// Rendering
//
// Each section is one sentence, a table, and a folded "How this was computed"
// note. Tables use the shared report classes only (no app CSS inside
// #resultsReport); findings live in a details row under their region or
// tract, so a reader scans the tables first and opens evidence on demand.
// ---------------------------------------------------------------------------

function el(doc, tag, attrs = {}, children = []) {
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? doc.createTextNode(child) : child);
  }
  return node;
}

const pct = (value, digits = 0) => (typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(digits)}%` : '—');
const plural = (n, word, words = `${word}s`) => `${n} ${n === 1 ? word : words}`;
const SHORT_COUNTS = {
  'Associations': 'association with symptom', 'Inverse associations': 'inverse association with symptom', 'Null findings': 'no association', 'Mixed results': 'mixed directions', 'Other / unclassified': 'direction unclassified',
};

/** "4 assoc., 1 null": the relationship breakdown of distinct findings. */
function countsShort(counts) {
  return Object.entries(counts).filter(([, n]) => n).map(([label, n]) => `${n} ${SHORT_COUNTS[label] || label.toLowerCase()}`).join(', ');
}

function countsText(counts) {
  const singular = {
    'Associations': 'association', 'Inverse associations': 'inverse association', 'Null findings': 'null finding',
    'Mixed results': 'mixed result', 'Other / unclassified': 'other / unclassified',
  };
  return Object.entries(counts).filter(([, n]) => n)
    .map(([label, n]) => `${n} ${n === 1 ? singular[label] : label.toLowerCase()}`).join(', ');
}

/** A citation key as a DOI link when the bibliography has one, with the full reference in the title. */
function citationNode(doc, kb, key) {
  const full = kb.citations?.[key] || '';
  const link = kb.citationLinks?.[key];
  const code = el(doc, 'code', { class: 'kb-cite', title: full, text: key });
  return link ? el(doc, 'a', { href: link, target: '_blank', rel: 'noopener noreferrer', title: full }, [code]) : code;
}

function citationCell(doc, kb, keys) {
  return el(doc, 'td', {}, keys.map((c, i) => el(doc, 'span', {}, [i ? ', ' : '', citationNode(doc, kb, c)])));
}

function stars(doc, n, label, score) {
  return el(doc, 'span', {
    class: 'kb-signal',
    title: `${n}/4, ${label}. A display heuristic for ordering only, not an evidence grade (raw score ${score >= 0 ? '+' : ''}${score.toFixed(2)}).`,
    'aria-label': `display signal ${n} of 4, ${label}`,
  }, [el(doc, 'span', { 'aria-hidden': 'true', text: n ? '★'.repeat(n) + '☆'.repeat(4 - n) : '—' })]);
}

function table(doc, className, headers, rows) {
  return el(doc, 'div', { class: 'nd-table-scroll' }, [el(doc, 'table', { class: `nd-data-table nd-table-right ${className}` }, [
    el(doc, 'thead', {}, [el(doc, 'tr', {}, headers.map(([text, numeric]) => el(doc, 'th', { class: numeric ? 'nd-numeric' : null, text })))]),
    el(doc, 'tbody', {}, rows),
  ])]);
}

/** Rows beyond `visible` start hidden, with one toggle row after them. */
function foldRows(doc, rows, visible, label, columns) {
  if (rows.length <= visible) return rows;
  const extra = rows.slice(visible);
  for (const row of extra) row.hidden = true;
  const button = el(doc, 'button', { type: 'button', class: 'nd-btn nd-btn-secondary nd-btn-sm kb-fold', text: `Show all ${label}` });
  button.addEventListener('click', () => {
    const open = extra[0].hidden;
    for (const row of extra) row.hidden = !open;
    button.textContent = open ? `Show fewer ${label}` : `Show all ${label}`;
  });
  return [...rows, el(doc, 'tr', { class: 'kb-fold-row' }, [el(doc, 'td', { colspan: String(columns) }, [button])])];
}

function method(doc, title, paragraphs) {
  return el(doc, 'details', { class: 'kb-method' }, [
    el(doc, 'summary', { class: 'nd-report-notes', text: title }),
    ...paragraphs.map((p) => el(doc, 'p', { class: 'nd-report-notes' }, p)),
  ]);
}

function findingArticle(doc, kb, finding) {
  const methodName = Array.isArray(finding.method) ? finding.method.join(', ') : (finding.method || 'method not reported');
  const stages = finding.stages?.length ? finding.stages.join('/') : 'phase not stated';
  const review = finding.review_kind === 'human' ? `reviewed by ${finding.reviewer}`
    : finding.review_kind === 'legacy' ? 'legacy approval' : finding.review_kind === 'model' ? `reviewed by ${finding.reviewer}` : 'no named reviewer';
  const citation = finding.citation || 'citation not recorded';
  const full = kb.citations?.[finding.citation];
  const more = [];
  const dl = (label, value) => el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'strong', { text: `${label}: ` }), value]);
  if (finding.sample && Object.keys(finding.sample).length) {
    more.push(dl('Sample', Object.entries(finding.sample).filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')} ${Array.isArray(v) ? v.join('; ') : v}`).join(' · ')));
  }
  if (finding.statistics && Object.keys(finding.statistics).length) {
    more.push(dl('Reported statistics', Object.entries(finding.statistics).filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k.replace(/_/g, ' ')} ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')));
  }
  if (finding.author_limitations?.length) more.push(dl('Author-reported limitations', finding.author_limitations.join(' · ')));
  if (finding.flags?.length) more.push(dl('Extraction flags', finding.flags.join(' · ')));
  if (full) more.push(dl('Full citation', full));
  for (const passage of finding.source_passages || []) {
    more.push(el(doc, 'blockquote', { class: 'kb-passage' }, [
      el(doc, 'p', { text: String(passage.quote || '') }),
      el(doc, 'footer', { class: 'nd-report-notes', text: [
        passage.page !== undefined && passage.page !== null ? `page ${passage.page}` : '', passage.section || '',
        passage.supports ? `supports ${String(passage.supports).replace(/_/g, ' ')}` : '',
      ].filter(Boolean).join(' · ') }),
    ]));
  }
  const design = designLine(finding);
  const draft = isDraftFinding(finding);
  return el(doc, 'article', { class: draft ? 'kb-finding kb-draft' : 'kb-finding' }, [
    el(doc, 'p', {}, [
      draft ? el(doc, 'span', { class: 'kb-draft-badge', text: 'Unreviewed draft', title: `Status: ${finding.source_status}. Extracted by a model; nobody has approved it yet.` }) : null,
      draft ? ' ' : null,
      finding.citation ? citationNode(doc, kb, finding.citation) : el(doc, 'code', { text: citation }), ' · ', String(finding.claim || ''),
    ]),
    el(doc, 'p', { class: 'nd-report-notes' }, [
      `Direction: ${DIRECTION_TEXT[finding.direction] || finding.direction || 'not reported'} (as stated in the claim above) · ${methodName} · `
      + `${finding.strength || 'strength not reported'} evidence · ${finding.confidence || 'confidence not reported'} extraction confidence · ${stages} · ${review}`
      + (finding.cohort ? ` · cohort: ${finding.cohort}` : ''),
    ]),
    design ? el(doc, 'p', { class: 'nd-report-notes kb-design' }, [el(doc, 'strong', { text: 'Design: ' }), design]) : null,
    finding.design_cautions?.length ? el(doc, 'p', { class: 'nd-report-notes kb-design-cautions' }, [el(doc, 'strong', { text: 'Design cautions: ' }), finding.design_cautions.join('; ')]) : null,
    more.length ? el(doc, 'details', {}, [el(doc, 'summary', { class: 'nd-report-notes', text: 'Study context and source passages' }), ...more]) : null,
  ]);
}

const ANALYSIS_TEXT = { univariate: 'univariate', multivariate: 'multivariate', region_based: 'region-based', network: 'network-level' };
const CORRECTION_TEXT = {
  permutation_fwe: 'permutation (FWE) correction', fwe: 'FWE correction', cluster_fwe: 'cluster-level FWE correction', fdr: 'FDR correction',
  bonferroni: 'Bonferroni correction', uncorrected: 'no multiple-comparison correction',
};
const VOLUME_TEXT = { direct: 'direct total lesion volume control', covariate: 'lesion volume as a covariate', none: 'lesion volume not controlled' };

/** A finding from an entry nobody has approved yet (only in the drafts export). */
export function isDraftFinding(finding) {
  return Boolean(finding?.source_status) && finding.source_status !== 'approved';
}

/** Schema v2.7 design line (report_evidence._design_html): how a lesion-mapping finding was obtained. */
export function designLine(finding) {
  if (!finding || finding.lm_source === null || finding.lm_source === undefined) return '';
  const parts = [];
  if (ANALYSIS_TEXT[finding.lm_analysis]) parts.push(`${ANALYSIS_TEXT[finding.lm_analysis]} lesion mapping`);
  if (typeof finding.lm_n === 'number' && Number.isFinite(finding.lm_n)) parts.push(`n = ${Math.round(finding.lm_n)}`);
  if (CORRECTION_TEXT[finding.lm_correction]) {
    const lean = { sensitivity: ' (leans sensitive)', specificity: ' (leans specific)' }[finding.lm_orientation] || '';
    parts.push(CORRECTION_TEXT[finding.lm_correction] + lean);
  }
  if (VOLUME_TEXT[finding.lm_volume_correction]) parts.push(VOLUME_TEXT[finding.lm_volume_correction]);
  if (!parts.length) return '';
  const how = { inferred: ' — read from the stated threshold and confounders', filled: ' — filled in by a model from the paper (quote checked), not yet reviewed' }[finding.lm_source] || '';
  return parts.join(' · ') + how;
}

/** A table row holding the findings of the row above it, grouped by outcome. */
function findingsRow(doc, kb, outcomes, columns, label) {
  const total = outcomes.reduce((n, g) => n + g.findings.length, 0);
  return el(doc, 'tr', { class: 'kb-findings-row' }, [el(doc, 'td', { colspan: String(columns) }, [
    el(doc, 'details', { class: 'kb-findings' }, [
      el(doc, 'summary', { class: 'nd-report-notes', text: `${plural(total, 'finding')} for ${label}` }),
      ...outcomes.map((group) => el(doc, 'section', {}, [
        el(doc, 'h4', { text: group.name }),
        el(doc, 'p', { class: 'nd-report-notes', text: countsText(group.counts) }),
        ...group.findings.map((f) => findingArticle(doc, kb, f)),
      ])),
    ]),
  ])]);
}

const targetsText = (targets) => targets.map((t) => (t.n > 1 ? `${t.name} (${t.n})` : t.name)).join(', ');

function measuresSection(doc, kb, measures, lesionSize) {
  const nodes = [];
  if (!lesionSize && !measures.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'No lesion volume was available for this run.' })]));
    return nodes;
  }
  if (lesionSize) {
    nodes.push(el(doc, 'p', {}, [
      el(doc, 'strong', { text: 'Lesion size first: ' }), `this lesion is ${lesionSize.volumeMl.toFixed(1)} mL`
      + (lesionSize.regions ? ` and the matched findings below concern ${plural(lesionSize.regions, 'damaged knowledge-base region')}` : '')
      + '. Larger lesions damage more regions and therefore match more findings, whatever their location, and lesion volume is itself one of the stronger correlates of severity. '
      + 'Read the number of findings below as partly a measure of lesion size.',
    ]));
  }
  if (!measures.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'The knowledge base has no findings about this measure.' })]));
    return nodes;
  }
  const columns = 5;
  const rows = [];
  for (const m of measures) {
    const counts = Object.entries(m.directionCounts).map(([d, n]) => `${n} ${DIRECTION_TEXT[d] || d}`).join(', ');
    rows.push(el(doc, 'tr', { class: 'kb-measure', 'data-measure': m.id }, [
      el(doc, 'td', { class: 'nd-numeric', text: m.id === 'lesion_volume' ? `${m.value.toFixed(1)} mL` : String(m.value) }),
      el(doc, 'td', {}, [el(doc, 'strong', { text: m.name }), m.id === 'lesion_volume' ? el(doc, 'span', { class: 'nd-report-notes', text: ' (this report\'s lesion mask, MNI space)' }) : null]),
      el(doc, 'td', { text: m.polarity ? m.polarity.charAt(0).toUpperCase() + m.polarity.slice(1) : 'See each finding' }),
      el(doc, 'td', { class: 'nd-numeric', text: String(m.distinct) }),
      el(doc, 'td', { text: counts }),
    ]));
    rows.push(findingsRow(doc, kb, m.outcomes, columns, m.name.toLowerCase()));
  }
  nodes.push(table(doc, 'kb-measure-table', [['Value', true], ['Measure'], ['Direction in the literature'], ['Findings', true], ['Relationships']], rows));
  nodes.push(el(doc, 'p', { class: 'nd-report-notes', text: 'Findings about measures report associations in study groups (for example, larger lesions with more severe aphasia), not predictions for one person. Selected observed difficulties mark matching direct-damage summaries; notes and raw scores do not alter literature matching.' }));
  return nodes;
}

function locationSection(doc, kb, report) {
  const { settings, coverage } = report;
  const nodes = [];
  if (report.laterality?.mainlyRight) {
    nodes.push(el(doc, 'p', { class: 'nd-message warning', role: 'note' }, [
      el(doc, 'strong', { text: 'Caution: ' }),
      'this lesion lies mainly in the right hemisphere. The knowledge base is almost entirely about left-hemisphere language regions, ',
      'so few or no findings apply; an absence of findings here does not mean an absence of deficits.',
    ]));
  }
  nodes.push(el(doc, 'p', {}, [
    `${report.shown} symptom-level findings concern regions this lesion damages (${report.matchedBeforeFilter} before excluding aphasia types and other non-symptom targets).`,
  ]));
  nodes.push(method(doc, 'How regions are matched and ranked', [
    [`A region counts as damaged when it holds ≥${settings.minOverlapPct}% of the lesion or ≥${settings.minRegionPct}% of it is damaged; regions are matched to the knowledge base `,
      `through its curated atlas mapping, never by name. Of the knowledge base's ${coverage.findings} location findings, ${coverage.undamaged} concern regions this lesion does not damage `,
      `and ${coverage.unmappable} concern regions no label atlas represents.`],
    ['The display signal (★) only orders the symptom summaries: it combines the share of each matched region damaged with the stored finding strength, study evidence class, ',
      'extraction confidence and relationship direction. It is not an evidence grade; counts do not measure certainty, and findings may share studies or cohorts. ',
      `Symptoms whose findings span at least ${settings.minSummaryCitations} citation keys and ${settings.minSummaryAnatomies} anatomies are listed first.`],
  ]));
  if (!report.summaries.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'No knowledge-base findings concern the damaged regions.' })]));
    return nodes;
  }
  const primary = report.summaries.filter((s) => s.primary);
  const secondary = report.summaries.filter((s) => !s.primary);
  const summaryRow = (s) => el(doc, 'tr', { 'data-target': s.target, class: s.primary ? null : 'kb-secondary' }, [
    el(doc, 'td', {}, [stars(doc, s.stars, s.strengthLabel, s.score)]),
    el(doc, 'td', {}, [el(doc, 'strong', { text: s.name })]),
    el(doc, 'td', { class: 'nd-numeric', text: String(s.distinct) }),
    el(doc, 'td', { text: countsShort(s.counts) }),
    el(doc, 'td', { text: s.regions.join(', ') }),
    citationCell(doc, kb, s.citations),
  ]);
  nodes.push(el(doc, 'h4', { text: 'Symptoms with evidence in the damaged regions' }));
  const summaryRows = [...primary.map(summaryRow), ...secondary.map(summaryRow)];
  nodes.push(table(doc, 'kb-symptom-table', [['Signal'], ['Symptom'], ['Findings', true], ['Relationships'], ['Damaged regions with findings'], ['Sources']],
    foldRows(doc, summaryRows, Math.max(primary.length, 1), `${plural(summaryRows.length, 'symptom')} (${secondary.length} below the display criterion)`, 6)));

  const regionDetailsStart = nodes.length;
  const columns = 5;
  const regionRows = [];
  for (const r of report.regions) {
    regionRows.push(el(doc, 'tr', { class: 'kb-region', 'data-region': r.region }, [
      el(doc, 'td', { class: 'nd-numeric', text: pct(r.lesion_pct, 1) }),
      el(doc, 'td', {}, [
        el(doc, 'strong', { text: r.name }),
        r.synonyms.length ? el(doc, 'span', { class: 'nd-report-notes', title: `Knowledge-base entries: ${r.synonyms.join('; ')}`, text: ` (${plural(r.synonyms.length, 'KB entry', 'KB entries')})` }) : null,
        r.judgementCall ? el(doc, 'span', { class: 'nd-report-notes', text: ' · mapping judgement call' }) : null,
      ]),
      el(doc, 'td', { class: 'nd-numeric', text: pct(r.region_pct) }),
      el(doc, 'td', { class: 'nd-numeric', title: r.thin !== null ? `Limited citation base: ${plural(r.thin, 'citation key')}` : null, text: `${r.distinct}${r.thin !== null ? ' *' : ''}` }),
      el(doc, 'td', { text: targetsText(r.targets) }),
    ]));
    regionRows.push(findingsRow(doc, kb, r.outcomes, columns, r.name));
  }
  nodes.push(table(doc, 'kb-region-table', [['Lesion %', true], ['Region'], ['Damaged', true], ['Findings', true], ['Symptom targets']],
    foldRows(doc, regionRows, Math.max(1, settings.maxEvidenceRegions) * 2, `${plural(report.regions.length, 'region')}`, columns)));
  nodes.push(el(doc, 'p', { class: 'nd-report-notes', text:
    `Ranked by the share of the lesion each region holds, then by the share damaged. * limited citation base (${settings.thinStudies} citation keys or fewer), not a certainty rating. `
    + 'Open a row\'s findings to read each claim with its citation, method, relationship and source passages.' }));
  const regionDetails = el(doc, 'details', {}, [el(doc, 'summary', { text: 'Region-level evidence details' }), ...nodes.splice(regionDetailsStart)]);
  nodes.push(regionDetails);
  return nodes;
}

function jhuOverlapSection(doc, rows) {
  if (!rows) return [];
  const nodes = [
    el(doc, 'h4', { text: 'Direct tract overlap (JHU)' }),
    el(doc, 'p', { class: 'nd-report-notes', text: 'Anatomical overlap with a reference atlas; this does not measure the patient’s white-matter connectivity.' }),
    method(doc, 'How JHU overlap is measured', [
      'The MNI-space lesion is sampled with nearest-neighbour interpolation onto the JHU white-matter tractography atlas: 2 mm maximum-probability labels, thresholded at 50%. Lesion % is overlapping voxels divided by all lesion voxels on that grid. Tract ROI covered % is overlapping voxels divided by the whole labelled tract region. Neither percentage is the fraction of fibres disconnected.',
      'This high-confidence map covers only parts of the tracts. Several atlas labels, including uncinate and cingulum, have no voxels at this threshold. No overlap does not establish that a tract is spared. Eligible KB findings for JHU-mapped regions enter the lesion-location evidence above.',
    ]),
  ];
  if (!rows.length) {
    nodes.push(el(doc, 'p', { text: 'The lesion does not overlap the labelled tract cores in this JHU map.' }));
    return nodes;
  }
  nodes.push(table(doc, 'jhu-overlap-table', [['Tract region'], ['Overlapping voxels', true], ['Lesion %', true], ['Tract ROI covered %', true]],
    [...rows].sort((a, b) => b.overlap_voxels - a.overlap_voxels).map(row => el(doc, 'tr', { 'data-region-id': row.region_id }, [
      el(doc, 'td', { text: row.region }),
      el(doc, 'td', { class: 'nd-numeric', text: String(row.overlap_voxels) }),
      el(doc, 'td', { class: 'nd-numeric', text: pct(100 * row.overlap_voxels / row.total_lesion_voxels, 1) }),
      el(doc, 'td', { class: 'nd-numeric', text: pct(100 * row.overlap_voxels / row.total_region_voxels, 1) }),
    ]))));
  return nodes;
}

function whiteMatterSection(doc, kb, report, { disconnectomeLabel, bundles }) {
  const { settings } = report;
  const nodes = [];
  const withFindings = report.tracts.length;
  nodes.push(el(doc, 'p', {}, [
    `${plural(report.qualifying, 'tract')} at or above ${settings.minDisconnectedPct}% of their streamlines through the lesion`
    + (withFindings ? `, ${withFindings} with knowledge-base findings.` : '.')
    + ' This streamline-based estimate is separate from direct anatomical tract overlap.',
  ]));
  nodes.push(method(doc, 'How disconnection is measured', [
    [`The warped lesion is resampled onto the FSL MNI152 1 mm grid and scored against the ${disconnectomeLabel} (${bundles} bundles) with nii2tvx, the Disconnectome webapp's engine: `,
      `for each bundle, the fraction of its streamlines passing through the lesion. A knowledge-base tract region takes the largest fraction of its bundles and counts as disconnected at ≥${settings.minDisconnectedPct}%. `,
      'A cross-reference (†) means the same symptom target also has direct-damage evidence from another anatomy above; it is not independent or additive evidence.'],
  ]));
  if (report.message) nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: report.message })]));
  const columns = 5;
  const rows = [];
  for (const t of report.tracts) {
    rows.push(el(doc, 'tr', { class: 'kb-tract', 'data-region': t.region }, [
      el(doc, 'td', { class: 'nd-numeric', text: pct(t.region_pct) }),
      el(doc, 'td', {}, [
        el(doc, 'strong', { text: t.name }),
        t.synonyms.length ? el(doc, 'span', { class: 'nd-report-notes', title: `Knowledge-base entries: ${t.synonyms.join('; ')}`, text: ` (${plural(t.synonyms.length, 'KB entry', 'KB entries')})` }) : null,
      ]),
      el(doc, 'td', { class: 'nd-numeric', text: t.directlyDamagedPct !== null ? pct(t.directlyDamagedPct) : '—' }),
      el(doc, 'td', { class: 'nd-numeric', title: t.thin !== null ? `Limited citation base: ${plural(t.thin, 'citation key')}` : null, text: `${t.distinct}${t.thin !== null ? ' *' : ''}` }),
      el(doc, 'td', {}, [
        targetsText(t.targets),
        t.shared.length ? el(doc, 'span', { class: 'nd-report-notes', title: t.shared.map((s) => `${s.name}: this tract ${countsText(s.tractCounts)}; direct damage elsewhere ${countsText(s.directCounts)}`).join(' · '), text: ' †' }) : null,
      ]),
    ]));
    rows.push(findingsRow(doc, kb, t.outcomes, columns, t.name));
  }
  for (const t of report.anatomyOnly) {
    rows.push(el(doc, 'tr', { class: 'kb-tract kb-tract-anatomy', 'data-region': t.region }, [
      el(doc, 'td', { class: 'nd-numeric', text: pct(t.region_pct) }),
      el(doc, 'td', {}, [t.name, t.synonyms.length ? el(doc, 'span', { class: 'nd-report-notes', title: `Knowledge-base entries: ${t.synonyms.join('; ')}`, text: ` (${plural(t.synonyms.length, 'KB entry', 'KB entries')})` }) : null]),
      el(doc, 'td', { class: 'nd-numeric', text: t.directlyDamagedPct !== null ? pct(t.directlyDamagedPct) : '—' }),
      el(doc, 'td', { class: 'nd-numeric', text: '0' }),
      el(doc, 'td', { class: 'nd-report-notes', text: 'no eligible symptom-level finding in the knowledge base' }),
    ]));
  }
  if (rows.length) {
    nodes.push(table(doc, 'kb-tract-table', [['Streamlines through lesion', true], ['Tract'], ['Directly damaged', true], ['Findings', true], ['Symptom targets']], rows));
    if (report.anatomyOnly.length) {
      nodes.push(el(doc, 'p', { class: 'nd-report-notes', text: 'A tract without a linked finding is anatomical context only; the absence of a finding is not evidence that it has no functional importance.' }));
    }
  }
  return nodes;
}

function therapySection(doc, kb, therapies) {
  const nodes = [];
  nodes.push(el(doc, 'p', {}, [
    `${plural(therapies.length, 'therapy', 'therapies')} with knowledge-base evidence for the symptoms above, ordered by how many of them each addresses. `,
    'Matched from the lesion alone. Observed difficulties highlight direct-damage evidence; notes and assessment results do not change therapy rankings; clinical assessment is needed to interpret their relevance.',
  ]));
  if (!therapies.length) {
    nodes.push(el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', { text: 'No therapy entry matched the impairments the damaged regions point to.' })]));
    return nodes;
  }
  const rows = therapies.map((t, index) => {
    const description = t.short_description.length > 160 ? `${t.short_description.slice(0, 160)}…` : t.short_description;
    return el(doc, 'tr', { 'data-therapy': t.therapy_id }, [
      el(doc, 'td', { class: 'nd-numeric', text: String(index + 1) }),
      el(doc, 'td', {}, [
        el(doc, 'strong', { text: t.therapy_name }),
        t.evidenceStages.length ? el(doc, 'span', { class: 'nd-report-notes', text: ` · evidence from ${t.evidenceStages.join(' / ')} patients` }) : null,
      ]),
      el(doc, 'td', { text: t.lesion_names.join(', ') || '—' }),
      el(doc, 'td', { text: t.ingredients.map((i) => (i.category ? `${i.name} (${i.category.replace(/_/g, ' ')})` : i.name)).join(', ') || '—' }),
      el(doc, 'td', { text: description }),
      citationCell(doc, kb, t.citations),
    ]);
  });
  nodes.push(table(doc, 'kb-therapy-table', [['#', true], ['Therapy'], ['Addresses'], ['Active ingredients (RTSS)'], ['Description'], ['Sources']], rows));
  return nodes;
}

function provenanceNode(doc, kb, context) {
  const v = kb.version || {};
  const entries = v.entries || {};
  const version = v.commit ? `version ${v.commit} (${v.date})` : `content digest ${v.contentDigest || 'unknown'}`;
  const atlases = [
    context.measured?.length ? `Label atlases measured: ${context.measured.join(', ')}.` : null,
    context.unmeasured?.length ? `No labelled lesion voxels in: ${context.unmeasured.join(', ')}.` : null,
    context.missingAtlases?.length ? `Not hosted in this build: ${context.missingAtlases.join(', ')} (their knowledge-base units are reported as not measured).` : null,
  ].filter(Boolean).join(' ');
  return el(doc, 'details', { class: 'kb-provenance' }, [
    el(doc, 'summary', { class: 'nd-report-notes', text:
      `Provenance and caveats · knowledge base ${version}, ${v.findings ?? '?'} findings from ${v.papers ?? '?'} papers, statuses: ${(v.statuses || []).join(', ')} · research use only, not a diagnosis` }),
    el(doc, 'p', { class: 'nd-report-notes', text:
      `Knowledge base ${version}, exported ${v.exportedOn || 'n/a'}: ${v.papers ?? '?'} papers, ${v.findings ?? '?'} extracted findings (${v.findingsReviewed ?? '?'} approved by a named reviewer) in `
      + `${Object.values(entries).reduce((a, b) => a + b, 0)} entries (${entries.regions ?? 0} regions, ${entries.impairments ?? 0} impairments, ${entries.therapies ?? 0} therapies, ${entries.predictors ?? 0} predictors).` }),
    (v.statuses || []).some((s) => s !== 'approved') ? el(doc, 'p', { class: 'nd-report-notes kb-drafts-note', text:
      `This report includes unreviewed drafts (statuses: ${v.statuses.join(', ')}): findings a model extracted that nobody has approved yet, `
      + 'each marked "Unreviewed draft". Choose "Approved findings only" under Run analysis for the reviewed evidence.' }) : null,
    el(doc, 'p', { class: 'nd-report-notes', text: `${atlases} ${context.disconnectomeNote || 'Disconnectome: not computed.'}` }),
    el(doc, 'p', { class: 'nd-report-notes', text:
      'The lesion was registered to MNI space by SynthMorph and the atlases are matched by world coordinates; overlaps depend on how well this brain was registered, '
      + 'which matters most for small or thin regions. Every finding is a group-level literature association with its citation; none is a prediction for this person.' }),
  ]);
}

/** Render the three sections (and the provenance line) into the Results report. */
export function renderKbReport(doc, result, { kb, context = {} }) {
  doc.getElementById('kbReportHeading')?.classList.remove('hidden');
  const body = (key) => doc.getElementById(BODY_IDS[key]);
  const section = (key) => doc.getElementById(SECTION_IDS[key]);
  const fill = (key, nodes) => {
    const target = body(key);
    if (!target) return;
    target.replaceChildren(...nodes);
    section(key)?.classList.remove('hidden');
  };
  fill('measures', measuresSection(doc, kb, result.measures || [], result.lesionSize || null));
  fill('location', locationSection(doc, kb, result.location));
  const whiteMatterIntro = el(doc, 'p', { class: 'nd-report-notes', text: 'Direct tract overlap locates visible lesion damage in an anatomical atlas. Streamline-based disconnection estimates a different property: reference fibres passing through the lesion.' });
  if (result.whiteMatter) {
    fill('whiteMatter', [whiteMatterIntro, ...jhuOverlapSection(doc, context.jhuOverlap), el(doc, 'h4', { text: 'Streamline-based disconnection (ENIGMA)' }), ...whiteMatterSection(doc, kb, result.whiteMatter, {
      disconnectomeLabel: context.disconnectomeLabel || 'ENIGMA Symmetric tractography atlas', bundles: context.bundles ?? 65,
    })]);
  } else {
    fill('whiteMatter', [whiteMatterIntro, ...jhuOverlapSection(doc, context.jhuOverlap), el(doc, 'h4', { text: 'Streamline-based disconnection (ENIGMA)' }), el(doc, 'p', { class: 'nd-report-notes' }, [el(doc, 'em', {
      text: context.disconnectomeError
        ? `The disconnectome could not be computed: ${context.disconnectomeError}`
        : 'The disconnectome was not computed for this lesion.',
    })])]);
  }
  fill('therapy', therapySection(doc, kb, result.therapy));
  const provenance = doc.getElementById(SECTION_IDS.provenance);
  if (provenance) {
    provenance.replaceChildren(provenanceNode(doc, kb, context));
    provenance.classList.remove('hidden');
  }
}

export function clearKbReport(doc) {
  doc.getElementById('kbReportHeading')?.classList.add('hidden');
  for (const key of Object.keys(BODY_IDS)) {
    doc.getElementById(BODY_IDS[key])?.replaceChildren();
    doc.getElementById(SECTION_IDS[key])?.classList.add('hidden');
  }
  const provenance = doc.getElementById(SECTION_IDS.provenance);
  if (provenance) {
    provenance.replaceChildren();
    provenance.classList.add('hidden');
  }
}

export { SECTION_IDS as KB_SECTION_IDS, BODY_IDS as KB_BODY_IDS };
