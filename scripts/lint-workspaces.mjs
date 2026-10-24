#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getPackages } from '@manypkg/get-packages';

// Preserve all workspace syntax/type checks. Skip only the exact ESLint task
// replaced by the central gate, and its exact scoped delegation contract.
export function preservedLintFilters(packages) {
  return packages.flatMap(({ packageJson }) => {
    const lint = packageJson.scripts?.lint;
    const delegates = /^node (?:\.\.\/)+scripts\/lint\.mjs --workspace$/.test(lint ?? '');
    return lint && lint !== 'eslint .' && !delegates ? [`--filter=${packageJson.name}`] : [];
  });
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { packages } = await getPackages(root);
  const filters = preservedLintFilters(packages);
  if (filters.length > 0) {
    const args = ['exec', 'turbo', 'run', 'lint', ...filters];
    // pnpm's entry point can be a Node script or a standalone executable.
    const entry = process.env.npm_execpath;
    const nodeScript = /\.(?:js|cjs|mjs)$/i.test(entry ?? '');
    const command = nodeScript ? process.execPath : entry || 'pnpm';
    const commandArgs = nodeScript ? [entry, ...args] : args;
    const result = spawnSync(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
