#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const { packages } = await getPackages(root);
  const filters = preservedLintFilters(packages);
  if (filters.length > 0) {
    const args = ['exec', 'turbo', 'run', 'lint', ...filters];
    // pnpm sets its script entry point, avoiding Windows .cmd shell execution.
    const command = process.env.npm_execpath ? process.execPath : 'pnpm';
    const commandArgs = process.env.npm_execpath ? [process.env.npm_execpath, ...args] : args;
    const result = spawnSync(command, commandArgs, {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  }
}
