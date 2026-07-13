#!/usr/bin/env node
import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';

const maxCloudflareAsset = 25 * 1024 * 1024;
const forbidden = [];
const oversized = [];

async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) await walk(full);
    else {
      const path = relative(repoRoot, full);
      const size = (await stat(full)).size;
      if (/\.(onnx|pt|pth|safetensors)$/i.test(entry.name)) forbidden.push(path);
      if (size > maxCloudflareAsset) oversized.push(`${path} (${size} bytes)`);
    }
  }
}

const registry = await loadAppsRegistry();
for (const app of registry.apps) await stat(join(repoRoot, 'apps', app.id, 'package.json'));
await walk(join(repoRoot, 'dist'));

if (forbidden.length || oversized.length) {
  throw new Error([
    forbidden.length ? `Model/weight files must live on Hugging Face:\n${forbidden.join('\n')}` : '',
    oversized.length ? `Assets exceed Cloudflare Pages' 25 MiB limit:\n${oversized.join('\n')}` : '',
  ].filter(Boolean).join('\n\n'));
}
console.log(`Artifact audit passed for ${registry.apps.length} apps.`);
