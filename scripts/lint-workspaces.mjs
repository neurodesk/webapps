#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Preserve package type checks and syntax checks. Root ESLint replaces empty
// app ESLint tasks; running those directly would bypass the reviewed baseline.
const root = fileURLToPath(new URL('../', import.meta.url));
const filters = [];
for (const directory of ['apps', 'packages', 'site/easter-eggs']) {
  for (const entry of await readdir(new URL(`../${directory}/`, import.meta.url), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = new URL(`../${directory}/${entry.name}/package.json`, import.meta.url);
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (manifest.scripts?.lint && !/^eslint\b/.test(manifest.scripts.lint)) {
      filters.push(`--filter=${manifest.name}`);
    }
  }
}
const result = spawnSync('pnpm', ['exec', 'turbo', 'run', 'lint', ...filters], { cwd: root, stdio: 'inherit', env: { ...process.env, TURBO_TELEMETRY_DISABLED: '1' } });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
