#!/usr/bin/env node
import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(process.argv[2] ?? '.');
const files = [];
const generatedOrVendoredDirectories = new Set([
  'dcm2niix',
  'dist',
  'nifti-js',
  'node_modules',
  'pkg',
  'preprocessing-wasm',
  'vendor',
  'wasm',
]);

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && generatedOrVendoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) files.push(path);
  }
}
await walk(root);
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status) process.exit(result.status);
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
