import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { repoRoot } from './apps-registry.mjs';

export const appInformationPath = join(repoRoot, 'registry', 'app-information.yml');

const HTTP = /^https:\/\/\S+$/;
const DOI = /^10\.\d{4,9}\/\S+$/;

function text(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Load and validate registry/app-information.yml. Every app in the catalog
 * must have packages and citations; every citation needs a resolvable DOI or
 * URL. The shared statements are validated once and rendered by the shell.
 */
export async function loadAppInformation(registry, path = appInformationPath) {
  const data = parse(await readFile(path, 'utf8'));
  const errors = [];
  const shared = data?.shared ?? {};
  for (const key of ['builder', 'execution', 'ecosystem', 'ecosystem_name', 'ecosystem_url']) {
    if (!text(shared[key])) errors.push(`shared.${key} must be a non-empty string`);
  }
  if (!/lightNIIng/.test(shared.ecosystem ?? '') || !/lightniing\.org/.test(shared.ecosystem ?? '')) errors.push('shared.ecosystem must name the lightNIIng ecosystem and its domain lightniing.org');
  if (shared.ecosystem_url !== 'https://lightniing.org') errors.push('shared.ecosystem_url must be https://lightniing.org');
  if (!/clinical translation/.test(shared.ecosystem ?? '')) errors.push('shared.ecosystem must state the clinical-translation aim');
  if (!/Neurodesk/.test(shared.builder ?? '')) errors.push('shared.builder must name Neurodesk');
  if (!/browser/.test(shared.execution ?? '')) errors.push('shared.execution must state that apps run in the browser by default');
  validateCitation(shared.platform_citation, 'shared.platform_citation', errors);
  if (shared.platform_citation?.doi !== '10.1038/s41592-023-02145-x') errors.push('shared.platform_citation must be the Neurodesk Nature Methods paper');

  const apps = data?.apps ?? {};
  const ids = new Set(registry.apps.map((app) => app.id));
  for (const id of Object.keys(apps)) if (!ids.has(id)) errors.push(`app-information names unknown app '${id}'`);
  for (const app of registry.apps) {
    const id = app.id;
    const info = apps[id];
    if (!info) { errors.push(`missing app-information entry for ${id}`); continue; }
    if (info.builders !== undefined && !text(info.builders)) errors.push(`${id}.builders must be a non-empty string when present`);
    if (info.execution !== undefined && !(text(info.execution) && /browser|server|computer|machine/i.test(info.execution))) {
      errors.push(`${id}.execution must be a sentence saying where processing happens when present`);
    }
    if (info.about !== undefined && (!Array.isArray(info.about) || !info.about.length || !info.about.every(text))) {
      errors.push(`${id}.about must be a non-empty list of paragraphs when present`);
    }
    if (!Array.isArray(info.packages) || !info.packages.length) errors.push(`${id}.packages must list at least one package`);
    for (const [index, item] of (info.packages ?? []).entries()) {
      if (!text(item?.name)) errors.push(`${id}.packages[${index}].name is required`);
      if (!HTTP.test(item?.url ?? '')) errors.push(`${id}.packages[${index}].url must be an https URL`);
      if (!text(item?.role)) errors.push(`${id}.packages[${index}].role is required`);
    }
    if (!Array.isArray(info.citations) || !info.citations.length) errors.push(`${id}.citations must list at least one citation`);
    for (const [index, item] of (info.citations ?? []).entries()) {
      if (!text(item?.group)) errors.push(`${id}.citations[${index}].group is required`);
      validateCitation(item, `${id}.citations[${index}]`, errors);
    }
    // Experimental scaffolds may cite software only; released apps cite their methods' papers.
    if (app.support_status !== 'experimental' && !(info.citations ?? []).some((item) => item?.doi)) {
      errors.push(`${id}.citations must include at least one paper with a DOI`);
    }
  }
  if (errors.length) throw new Error(`Invalid app information:\n- ${errors.join('\n- ')}`);

  return Object.freeze({
    shared: deepFreeze(shared),
    apps: deepFreeze(apps),
  });
}

function validateCitation(item, label, errors) {
  if (!item || typeof item !== 'object') { errors.push(`${label} is required`); return; }
  if (!text(item.title)) errors.push(`${label}.title is required`);
  if (!text(item.reference)) errors.push(`${label}.reference is required`);
  if (item.doi !== undefined && !DOI.test(item.doi)) errors.push(`${label}.doi must look like 10.xxxx/…`);
  if (item.url !== undefined && !HTTP.test(item.url)) errors.push(`${label}.url must be an https URL`);
  if (item.doi === undefined && item.url === undefined) errors.push(`${label} needs a doi or url`);
  if (item.code !== undefined && !HTTP.test(item.code)) errors.push(`${label}.code must be an https URL`);
}

function deepFreeze(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])));
  }
  return value;
}

/** The JSON payload the shell receives for one app. */
export function appInformationPayload(information, appId) {
  const info = information.apps[appId];
  if (!info) throw new Error(`No app information for ${appId}`);
  return {
    shared: information.shared,
    builders: info.builders ?? null,
    execution: info.execution ?? null,
    about: info.about ?? [],
    packages: info.packages,
    citations: info.citations,
  };
}
