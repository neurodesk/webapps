#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCoiServiceWorker } from './lib/runtime-support.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const appDir = process.cwd();
const manifest = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'));
if (manifest.neurodeskWebapp?.static?.coiServiceWorker) {
  await writeCoiServiceWorker({
    repoRoot,
    destination: join(appDir, 'web', 'coi-serviceworker.js'),
    config: manifest.neurodeskWebapp.static.coiServiceWorker,
  });
  console.log(`Generated COI service worker for ${manifest.name}`);
}
