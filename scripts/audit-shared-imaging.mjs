#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const apps = ['calmar', 'musclemap', 'seedseg', 'spinalcordtoolbox', 'vesselboost'];
const tokenApps = [...apps, 'qsmbly'];
const stylesRoot = join(repoRoot, 'packages', 'components', 'src', 'styles');
const appStyle = (app) => join(repoRoot, 'apps', app, 'web', 'css', 'styles.css');
const legacyTokenUse = /var\(--(?:color|space|radius|shadow|transition)-/;

async function collectOwnedUiSources(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (['vendor', 'dcm2niix', 'nifti-js', 'freebrowse-viewer', 'onnxruntime', 'wasm'].includes(entry.name)) continue;
      files.push(...await collectOwnedUiSources(join(directory, entry.name)));
    } else if (/\.(?:css|html|js)$/.test(entry.name)) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

async function ownedUiSources(app) {
  if (app !== 'qsmbly') return collectOwnedUiSources(join(repoRoot, 'apps', app, 'web'));
  return [
    join(repoRoot, 'apps', app, 'index.html'),
    ...await collectOwnedUiSources(join(repoRoot, 'apps', app, 'css')),
    ...await collectOwnedUiSources(join(repoRoot, 'apps', app, 'js')),
  ];
}

function canonicalTokens(css) {
  return css
    .replaceAll('var(--color-', 'var(--nd-color-')
    .replaceAll('var(--space-', 'var(--nd-space-')
    .replaceAll('var(--radius-', 'var(--nd-radius-')
    .replaceAll('var(--shadow-', 'var(--nd-shadow-')
    .replaceAll('var(--transition-', 'var(--nd-transition-');
}

function topLevelRules(css) {
  return [...css.matchAll(/^(?!\s|@)([^{}\n][^{]*)\{([^{}]*)\}/gm)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
    key: `${match[1].trim().replace(/\s+/g, ' ')}\0${match[2].trim().replace(/\s+/g, ' ')}`,
  }));
}

async function fix() {
  const originalBase = await readFile(join(stylesRoot, 'base.css'), 'utf8');
  const aliases = originalBase.indexOf('  /* Compatibility aliases');
  const reset = originalBase.indexOf('*, *::before');
  const inferenceStart = originalBase.indexOf('/* Stable class contract');
  const imagingStart = originalBase.indexOf('/* Shared chrome');
  const hasLegacyLayout = [aliases, reset, inferenceStart, imagingStart].every((offset) => offset >= 0);

  let base;
  let inference;
  let imaging;
  if (hasLegacyLayout) {
    base = `${originalBase.slice(0, aliases).trimEnd()}\n}\n\n${originalBase.slice(reset, inferenceStart).trim()}\n`;
    inference = canonicalTokens(originalBase.slice(inferenceStart, imagingStart).trim());
    imaging = originalBase.slice(imagingStart).trim();
  } else {
    base = canonicalTokens(originalBase).trim() + '\n';
    inference = (await readFile(join(stylesRoot, 'inference-workspace.css'), 'utf8'))
      .replace(/^@import url\(['"]\.\/base\.css['"]\);\s*/, '')
      .trim();
    imaging = (await readFile(join(stylesRoot, 'imaging-workspace.css'), 'utf8'))
      .replace(/^@import url\(['"]\.\/base\.css['"]\);\s*/, '')
      .trim();
  }
  await writeFile(join(stylesRoot, 'base.css'), base);

  const sheets = await Promise.all(apps.map(async (app) => ({
    app,
    css: canonicalTokens(await readFile(appStyle(app), 'utf8')),
  })));
  const occurrences = new Map();
  for (const sheet of sheets) {
    for (const rule of topLevelRules(sheet.css)) {
      const entries = occurrences.get(rule.key) || [];
      entries.push({ sheet, rule });
      occurrences.set(rule.key, entries);
    }
  }
  const shared = [...occurrences.values()].filter((entries) => new Set(entries.map(({ sheet }) => sheet.app)).size >= 2);
  const existing = new Set(topLevelRules(inference).map(({ key }) => key));
  const additions = [];
  for (const entries of shared) {
    if (!existing.has(entries[0].rule.key)) {
      additions.push(entries[0].rule.text);
      existing.add(entries[0].rule.key);
    }
    for (const { sheet, rule } of entries) {
      sheet.removals ||= [];
      sheet.removals.push([rule.start, rule.end]);
    }
  }
  for (const sheet of sheets) {
    for (const [start, end] of (sheet.removals || []).sort((a, b) => b[0] - a[0])) {
      sheet.css = `${sheet.css.slice(0, start)}${sheet.css.slice(end)}`;
    }
    sheet.css = sheet.css.replace(/\n{3,}/g, '\n\n').trim() + '\n';
    await writeFile(appStyle(sheet.app), sheet.css);
  }
  if (additions.length) inference += `\n\n/* Exact rules promoted from two or more inference applications. */\n${additions.join('\n')}\n`;
  await writeFile(join(stylesRoot, 'inference-workspace.css'), `@import url('./base.css');\n\n${inference.trim()}\n`);
  await writeFile(join(stylesRoot, 'imaging-workspace.css'), `@import url('./base.css');\n\n${imaging}\n`);

  for (const app of apps) {
    const htmlPath = join(repoRoot, 'apps', app, 'web', 'index.html');
    const html = await readFile(htmlPath, 'utf8');
    await writeFile(htmlPath, html.replace('src/styles/base.css', 'src/styles/inference-workspace.css'));
    for (const path of await ownedUiSources(app)) {
      const source = await readFile(path, 'utf8');
      const canonical = canonicalTokens(source);
      if (canonical !== source) await writeFile(path, canonical);
    }
  }
  for (const path of await ownedUiSources('qsmbly')) {
    const source = await readFile(path, 'utf8');
    const canonical = canonicalTokens(source);
    if (canonical !== source) await writeFile(path, canonical);
  }
}

async function audit() {
  const errors = [];
  const base = await readFile(join(stylesRoot, 'base.css'), 'utf8');
  if (/--(?:color|space|radius|shadow|transition)-/.test(base)) errors.push('base.css contains legacy token declarations');
  for (const entry of ['inference-workspace.css', 'imaging-workspace.css']) {
    try { await readFile(join(stylesRoot, entry), 'utf8'); } catch { errors.push(`missing shared stylesheet: ${entry}`); }
  }
  for (const app of tokenApps) {
    for (const path of await ownedUiSources(app)) {
      if (legacyTokenUse.test(await readFile(path, 'utf8'))) errors.push(`${path.slice(repoRoot.length + 1)} uses a legacy CSS token`);
    }
  }
  const sheets = await Promise.all(apps.map(async (app) => ({ app, rules: new Set(topLevelRules(await readFile(appStyle(app), 'utf8')).map(({ key }) => key)) })));
  for (let left = 0; left < sheets.length; left += 1) {
    for (let right = left + 1; right < sheets.length; right += 1) {
      const common = [...sheets[left].rules].filter((rule) => sheets[right].rules.has(rule));
      if (common.length) errors.push(`${sheets[left].app}/${sheets[right].app} share ${common.length} exact top-level rules`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log('Shared imaging convergence audit passed.');
}

if (process.argv.includes('--fix')) await fix();
await audit();
