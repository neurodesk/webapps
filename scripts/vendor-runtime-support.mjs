#!/usr/bin/env node
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCoiServiceWorker } from './lib/runtime-support.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();
const manifest = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
const destinationArgument = process.argv.indexOf('--dest');
const staticRoot = destinationArgument === -1 ? 'web' : process.argv[destinationArgument + 1];
if (!staticRoot) throw new Error('--dest requires a directory');
const destinationRoot = join(appDir, staticRoot);

const runtimeSupport = join(repoRoot, 'packages', 'runtime-support');
const niftiJs = join(destinationRoot, 'nifti-js');
await rm(niftiJs, { recursive: true, force: true });
await cp(join(runtimeSupport, 'src', 'nifti-js'), niftiJs, { recursive: true });

// The JPEG build of @niivue/dcm2niix, pinned by runtime-support: worker, glue and WebAssembly side by side.
const dcm2niixDist = join(dirname(createRequire(join(runtimeSupport, 'package.json')).resolve('@niivue/dcm2niix/package.json')), 'dist');
const dcm2niix = join(destinationRoot, 'dcm2niix');
await rm(dcm2niix, { recursive: true, force: true });
await mkdir(dcm2niix, { recursive: true });
for (const name of ['index.jpeg.js', 'worker.jpeg.js', 'dcm2niix.jpeg.js', 'dcm2niix.jpeg.wasm']) {
  await cp(join(dcm2niixDist, name), join(dcm2niix, name));
}

if (manifest.neurodeskWebapp?.static?.coiServiceWorker) {
  await writeCoiServiceWorker({
    repoRoot,
    destination: join(destinationRoot, 'coi-serviceworker.js'),
    config: manifest.neurodeskWebapp.static.coiServiceWorker,
  });
  console.log(`Generated COI service worker for ${manifest.name}`);
}
// Bundler-less apps that embed FreeBrowse get its prebuilt bundle on their own
// origin, next to the other generated runtime files; nothing is fetched from a CDN.
if (manifest.neurodeskWebapp?.static?.freebrowseViewer) {
  const { vendorFreebrowseViewer } = await import('../packages/runtime-support/scripts/build-freebrowse-viewer.mjs');
  await vendorFreebrowseViewer(join(destinationRoot, 'freebrowse-viewer'));
  console.log(`Generated FreeBrowse viewer bundle for ${manifest.name}`);
}
console.log(`Generated imaging runtime wrappers for ${manifest.name}`);
