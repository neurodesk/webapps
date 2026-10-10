#!/usr/bin/env node
import { ESLint } from 'eslint';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertCoverage, sourceInventory } from './quality/lint-inventory.mjs';

export const root = realpathSync(fileURLToPath(new URL('../', import.meta.url))) + sep;
export function fingerprint(file, message, source) {
  const line = source.split(/\r?\n/)[message.line - 1] ?? '';
  const identity = [file, message.ruleId, message.message, line.trim()];
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export async function inspect(eslint, files, baseline) {
  await assertCoverage(eslint, files);
  const results = await eslint.lintFiles(files);
  const findings = [];
  const remaining = new Map(Object.entries(baseline));
  for (const result of results) {
    const file = relative(root, result.filePath).replaceAll('\\', '/');
    const source = result.source ?? await readFile(result.filePath, 'utf8');
    for (const message of result.messages) {
      if (message.severity !== 2) continue;
      const key = fingerprint(file, message, source);
      const count = remaining.get(key)?.count ?? 0;
      // Parser failures cannot be accepted as existing lint debt.
      if (!message.fatal && count > 0) {
        remaining.set(key, { ...remaining.get(key), count: count - 1 });
      } else {
        findings.push({ file, key, ...message });
      }
    }
  }
  return { findings, stale: [...remaining.entries()].filter(([, entry]) => entry.count > 0), results };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const allBaseline = JSON.parse(await readFile(new URL('./quality/lint-baseline.json', import.meta.url), 'utf8'));
  const eslint = new ESLint({ cwd: root, overrideConfigFile: `${root}eslint.config.js` });
  const workspace = process.argv.includes('--workspace') ? relative(root, realpathSync(process.cwd())).split(sep).join('/') : '';
  if (workspace.startsWith('..')) throw new Error('The lint workspace must be inside the repository.');
  const prefix = workspace ? `${workspace}/` : '';
  const baseline = Object.fromEntries(Object.entries(allBaseline).filter(([, entry]) => entry.file.startsWith(prefix)));
  const files = sourceInventory(root).filter((file) => file.startsWith(prefix));
  if (files.length === 0) throw new Error(`No owned source found in ${workspace || 'repository'}.`);
  const { findings, stale } = await inspect(eslint, files, baseline);
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.column} ${finding.ruleId ?? 'parse'} ${finding.message}`);
  }
  for (const [key, entry] of stale) {
    console.error(`Resolved lint baseline entry ${key} (${entry.file}, ${entry.ruleId}); remove it from scripts/quality/lint-baseline.json.`);
  }
  console.log(`Checked ${files.length} JS/TS source files; ${Object.keys(baseline).length} existing findings recorded; ${findings.length} new findings.`);
  if (findings.length || stale.length) process.exitCode = 1;
}
