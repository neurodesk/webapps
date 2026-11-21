#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { commandLineClosure } from './lib/module-closure.mjs';
import { repoRoot } from './lib/apps-registry.mjs';

const SHARED_PATHS_BLOCK = /(^ {6}shared_paths: \|\n)((?: {8}[^\n]*\n)+)/m;
const DRIVER_LINES = /(?:^ {8}packages\/node-drivers\/[^\n]+\n)+/gm;

// Syncs the generated packages/node-drivers/ filters of a portable CLI consumer
// workflow strictly inside jobs.gate.with.shared_paths (routed by native.yml on
// ready PRs and swept nightly, matching the repo's shared-path contract). Missing
// blocks fail loudly instead of silently passing --check or matching unrelated YAML.
export function syncDriverPathsInSource(file, source, dependencies) {
  const sharedLines = dependencies.map((entry) => `        ${entry}`).join('\n');
  const flow = YAML.parse(source);
  const match = SHARED_PATHS_BLOCK.exec(source);
  if (!flow.jobs?.gate?.with?.shared_paths || !match) {
    throw new Error(`${file}: missing jobs.gate.with.shared_paths block`);
  }
  const block = match[2];
  DRIVER_LINES.lastIndex = 0;
  if (!DRIVER_LINES.test(block)) {
    throw new Error(`${file}: missing packages/node-drivers/ entries in jobs.gate.with.shared_paths`);
  }
  DRIVER_LINES.lastIndex = 0;
  const replacedBlock = block.replace(DRIVER_LINES, `${sharedLines}\n`);
  return source.slice(0, match.index) + match[1] + replacedBlock + source.slice(match.index + match[0].length);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
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
    const updated = syncDriverPathsInSource(file, source, dependencies);
    if (source === updated) continue;
    if (process.argv.includes('--check')) throw new Error(`${file}: run node scripts/sync-native-driver-paths.mjs`);
    await writeFile(path, updated);
  }
}
