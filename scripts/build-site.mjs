#!/usr/bin/env node
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { assembleRuntimeAssetStore } from './lib/runtime-assets.mjs';

const registry = await loadAppsRegistry();
const siteDist = join(repoRoot, 'dist');
await rm(siteDist, { recursive: true, force: true });
await mkdir(siteDist, { recursive: true });

for (const app of registry.apps) {
  const source = join(repoRoot, 'apps', app.id, 'dist');
  const destination = join(siteDist, app.path);
  await cp(source, destination, { recursive: true });
}

await assembleRuntimeAssetStore({ repoRoot, siteDist, registry });

const escape = (value) => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;');

const cards = registry.apps.map((app) => `
      <a class="app" href="./${escape(app.path)}/">
        <h2>${escape(app.title)}</h2>
        <p>${escape(app.description)}</p>
      </a>`).join('');

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Neurodesk Webapps</title><style>
:root{color-scheme:light dark;font-family:Inter,system-ui,sans-serif}body{max-width:72rem;margin:auto;padding:3rem 1.5rem;background:#071521;color:#eef7ff}
h1{font-size:clamp(2.4rem,7vw,5rem);margin:.2em 0}.lede{max-width:48rem;color:#b9cad8;font-size:1.15rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1rem;margin-top:2.5rem}
.app{display:block;padding:1.3rem;border:1px solid #29495e;border-radius:1rem;color:inherit;text-decoration:none;background:#0d2231}.app:hover{border-color:#75c66a;transform:translateY(-2px)}
.app h2{margin:0 0 .5rem;color:#8bd57c}.app p{margin:0;color:#c6d5df;line-height:1.5}footer{margin-top:3rem;color:#8fa6b5}
</style></head><body><main><p>NEURODESK</p><h1>Webapps</h1><p class="lede">Privacy-preserving neuroimaging tools that run locally in your browser. Your imaging data is not uploaded.</p>
<section class="grid" aria-label="Available webapps">${cards}
</section></main></body></html>`;

await writeFile(join(siteDist, 'index.html'), html);
await writeFile(join(siteDist, '.nojekyll'), '');
await writeFile(join(siteDist, '_headers'), `/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: credentialless\n  X-Content-Type-Options: nosniff\n`);
console.log(`Assembled ${registry.apps.length} apps at ${siteDist}`);
