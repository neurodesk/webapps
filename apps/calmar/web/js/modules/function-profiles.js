import { fetchCacheFirst } from './atlas-loader.js';

const DEFAULT_ASSET_ID = 'yeo7-neurosynth-v7-function-profiles';
const DEFAULT_SOURCE_LABEL = 'Neurosynth v7 via NiMARE';
const ASSET_CACHE = 'lnm-assets-v1';

async function loadManifest() {
  if (typeof fetch === 'undefined') {
    throw new Error('fetch is required to load function-profile manifest');
  }
  const response = await fetch('./models/manifest.json');
  if (!response.ok) {
    throw new Error(`Failed to load manifest: HTTP ${response.status}`);
  }
  return response.json();
}

function normalizeAssetUrl(url) {
  if (!url) return url;
  if (typeof location !== 'undefined' && location.href) {
    return new URL(url, location.href).href;
  }
  return url;
}

function parseProfileJson(buffer) {
  return JSON.parse(new TextDecoder('utf-8').decode(buffer));
}

function validateProfiles(profiles, assetId) {
  if (!profiles || typeof profiles !== 'object') {
    throw new Error(`Function-profile asset ${assetId} is not an object`);
  }
  if (profiles.id && profiles.id !== assetId) {
    throw new Error(`Function-profile asset id ${profiles.id} does not match ${assetId}`);
  }
  if (!profiles.networkProfiles || typeof profiles.networkProfiles !== 'object') {
    throw new Error(`Function-profile asset ${assetId} is missing networkProfiles`);
  }
  return profiles;
}

export async function loadFunctionProfilesFromManifest(
  assetId = DEFAULT_ASSET_ID,
  { manifest } = {}
) {
  const assetManifest = manifest || await loadManifest();
  const manifestEntry = assetManifest.annotationAssets?.find(a => a.id === assetId);
  if (!manifestEntry) {
    throw new Error(`Function-profile asset not found: ${assetId}`);
  }
  if (manifestEntry.supportStatus !== 'supported') {
    throw new Error(`Function-profile asset is not supported: ${assetId}`);
  }

  let cache = null;
  if (typeof caches !== 'undefined') {
    cache = await caches.open(ASSET_CACHE);
  }
  const arrayBuffer = await fetchCacheFirst(
    normalizeAssetUrl(manifestEntry.sourceUrl),
    manifestEntry.cacheKey,
    cache
  );
  const profiles = validateProfiles(parseProfileJson(arrayBuffer), assetId);
  return { profiles, manifestEntry };
}

function networkWeight(row) {
  const value = Number(row?.fractionOfLesion);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function displayTerm(term) {
  return String(term || '').trim();
}

function termKey(term) {
  return displayTerm(term).toLocaleLowerCase();
}

export function rankFunctionalTerms(summary, profiles, {
  topN = 8,
  minScore = 0.01,
  maxContributors = 3
} = {}) {
  const networks = Array.isArray(summary?.networks) ? summary.networks : [];
  const networkProfiles = profiles?.networkProfiles || {};
  const byTerm = new Map();

  for (const row of networks) {
    const network = row?.network;
    if (!network || network === 'Unassigned') continue;
    const weight = networkWeight(row);
    if (weight <= 0) continue;

    const terms = Array.isArray(networkProfiles[network]) ? networkProfiles[network] : [];
    for (const termEntry of terms) {
      const term = displayTerm(termEntry.term);
      const sourceScore = Number(termEntry.score);
      if (!term || !Number.isFinite(sourceScore) || sourceScore <= 0) continue;

      const score = weight * sourceScore;
      if (score <= 0) continue;
      const key = termKey(term);
      const acc = byTerm.get(key) || {
        term,
        score: 0,
        contributors: []
      };
      acc.score += score;
      acc.contributors.push({
        network,
        contribution: score,
        weight,
        sourceScore
      });
      byTerm.set(key, acc);
    }
  }

  return Array.from(byTerm.values())
    .map(row => ({
      ...row,
      contributors: row.contributors
        .sort((a, b) => b.contribution - a.contribution || a.network.localeCompare(b.network))
        .slice(0, maxContributors)
    }))
    .filter(row => row.score >= minScore)
    .sort((a, b) => b.score - a.score || a.term.localeCompare(b.term))
    .slice(0, topN);
}

function appendCell(row, text, className = '') {
  const cell = document.createElement('td');
  if (className) cell.className = className;
  cell.textContent = text;
  row.appendChild(cell);
  return cell;
}

function contributorLabel(contributors) {
  if (!Array.isArray(contributors) || contributors.length === 0) return '';
  return contributors
    .map(item => item.network)
    .join('; ');
}

export function renderFunctionalProfileTable(tableEl, rankedTerms, {
  sourceLabel = DEFAULT_SOURCE_LABEL,
  emptyLabel = 'No functional associations',
  driverHeader = 'Network drivers'
} = {}) {
  tableEl.innerHTML = '';

  const caption = document.createElement('caption');
  caption.textContent = sourceLabel;
  tableEl.appendChild(caption);

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const label of ['Term', 'Score', driverHeader]) {
    const th = document.createElement('th');
    th.textContent = label;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  tableEl.appendChild(thead);

  const tbody = document.createElement('tbody');
  if (!Array.isArray(rankedTerms) || rankedTerms.length === 0) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.textContent = emptyLabel;
    row.appendChild(cell);
    tbody.appendChild(row);
    tableEl.appendChild(tbody);
    return;
  }

  for (const item of rankedTerms) {
    const row = document.createElement('tr');
    appendCell(row, item.term);
    appendCell(row, Number(item.score).toFixed(3), 'function-profile-score');
    appendCell(row, contributorLabel(item.contributors), 'function-profile-drivers');
    tbody.appendChild(row);
  }
  tableEl.appendChild(tbody);
}
