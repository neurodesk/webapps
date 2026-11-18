#!/usr/bin/env node
// The package step of ci.yml's workspace-contracts job: runs the package
// suites the plan lists. ALL_PACKAGES=true runs every suite (pnpm
// test:packages). Otherwise PACKAGES must be the plan's JSON list of distinct
// packages/<name> directories, each with the script its suite runs (`test`,
// or `test:unit` for the component package), and pnpm must match each
// directory's filter to that package. Anything else fails the step instead
// of testing less than the plan asked for. Each directory is one argument.
// scripts/lib/app-plan.mjs (PACKAGE_STEP) runs every package suite when this file changes.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const COMPONENTS = 'packages/components';
const PACKAGE_DIR = /^packages\/[\w.-]+$/;

// The suites to run for the plan's `packages` text, or an error naming why it cannot be run as asked.
export function plannedSuites(text, root) {
  let dirs;
  try {
    dirs = JSON.parse(text);
  } catch (error) {
    throw new Error(`the plan's package list is not JSON (${error.message})`);
  }
  if (!Array.isArray(dirs) || dirs.length === 0) throw new Error(`the plan's package list must be a non-empty array, not ${JSON.stringify(dirs)}`);
  if (new Set(dirs).size !== dirs.length) throw new Error('the plan lists a package twice');
  return dirs.map((dir) => {
    if (typeof dir !== 'string' || !PACKAGE_DIR.test(dir)) throw new Error(`${JSON.stringify(dir)} is not a packages/<name> directory`);
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    } catch (error) {
      throw new Error(`${dir} has no readable package.json (${error.code ?? error.message})`);
    }
    const script = dir === COMPONENTS ? 'test:unit' : 'test';
    if (!manifest.scripts?.[script]) throw new Error(`${dir} has no ${script} script`);
    return { dir, name: manifest.name, script };
  });
}

function pnpm(args, root, options = {}) {
  const result = spawnSync('pnpm', args, { cwd: root, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  return result;
}

// The suites pnpm's filters would not run: each directory must match exactly its own package.
export function unmatchedSuites(suites, root) {
  const listed = pnpm([...suites.flatMap(({ dir }) => ['--filter', `./${dir}`]), 'ls', '--depth', '-1', '--json'], root, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`pnpm ls exited with ${listed.status}`);
  const matched = new Set(JSON.parse(listed.stdout).map((project) => resolve(project.path)));
  return suites.filter(({ dir }) => !matched.has(resolve(root, dir)));
}

function main(root) {
  if (process.env.ALL_PACKAGES === 'true') return pnpm(['test:packages'], root).status;
  const suites = plannedSuites(process.env.PACKAGES ?? '', root);
  const unmatched = unmatchedSuites(suites, root);
  if (unmatched.length) throw new Error(`pnpm matches no workspace package for ${unmatched.map(({ dir }) => dir).join(', ')}`);
  const groups = [
    [suites.filter(({ dir }) => dir !== COMPONENTS), 'test'],
    [suites.filter(({ dir }) => dir === COMPONENTS), 'test:unit'],
  ].filter(([group]) => group.length);
  for (const [group, script] of groups) {
    console.log(`Testing ${group.map(({ dir }) => dir).join(', ')}`);
    const { status } = pnpm(['--fail-if-no-match', ...group.flatMap(({ dir }) => ['--filter', `./${dir}`]), 'run', script], root);
    if (status !== 0) return status;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(resolve(fileURLToPath(import.meta.url), '../..'));
  } catch (error) {
    console.error(`::error title=Package tests::${error.message}`);
    process.exitCode = 1;
  }
}
