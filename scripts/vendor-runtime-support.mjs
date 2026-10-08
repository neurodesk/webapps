#!/usr/bin/env node
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
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

for (const family of ['dcm2niix', 'nifti-js']) {
  const source = join(repoRoot, 'packages', 'runtime-support', 'src', family);
  const destination = join(destinationRoot, family);
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(source, destination, { recursive: true });
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
