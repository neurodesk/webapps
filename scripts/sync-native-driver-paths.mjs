#!/usr/bin/env node
import { readFile, readdir, writeFile } from 'node:fs/promises';
import YAML from 'yaml';
import { commandLineClosure } from './lib/module-closure.mjs';
import { repoRoot } from './lib/apps-registry.mjs';

// Browser reference jobs still need their component filters. Only replace
// Node-driver dependencies of portable CLI callers; drivers load caller-pinned
// runtimes, whose existing package/runtime filters remain in place.
for (const file of (await readdir(`${repoRoot}/.github/workflows`)).sort()) {
  if (!file.endsWith('.yml')) continue;
  const path = `${repoRoot}/.github/workflows/${file}`;
  const source = await readFile(path, 'utf8');
  const flow = YAML.parse(source);
  const directory = flow.jobs?.portable?.with?.package;
  if (!directory) continue;
  const dependencies = commandLineClosure(repoRoot, directory)
    .filter((entry) => entry.startsWith('packages/node-drivers/'));
  if (!dependencies.length) continue;
  const lines = dependencies.map((entry) => `      - '${entry}'`).join('\n');
  const updated = source.replace(/(?:^ {6}- 'packages\/node-drivers\/[^']+'\n)+/gm, `${lines}\n`);
  if (source === updated) continue;
  if (process.argv.includes('--check')) throw new Error(`${file}: run node scripts/sync-native-driver-paths.mjs`);
  await writeFile(path, updated);
}
