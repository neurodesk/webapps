// Copies dicompare's embedding kit (controller and Pyodide worker, apps/dicompare/public/embed)
// and its schema library into src/vendor/dicompare/, which Vite bundles with hashed names, so
// the app needs no request to dicompare.neurodesk.org. The directory is generated and gitignored.
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../../dicompare/public/', import.meta.url));
const destination = fileURLToPath(new URL('../src/vendor/dicompare/', import.meta.url));
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, 'schemas'), { recursive: true });
for (const name of ['DicompareController.js', 'dicompare-worker.js']) {
  await copyFile(join(source, 'embed', name), join(destination, name));
}
const index = JSON.parse(await readFile(join(source, 'schemas', 'index.json'), 'utf8'));
await copyFile(join(source, 'schemas', 'index.json'), join(destination, 'schemas', 'index.json'));
for (const path of index) await copyFile(join(source, 'schemas', basename(path)), join(destination, 'schemas', basename(path)));
