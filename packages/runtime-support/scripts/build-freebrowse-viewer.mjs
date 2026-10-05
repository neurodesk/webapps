#!/usr/bin/env node
// Builds the self-contained FreeBrowse viewer bundle for bundler-less apps.
// FreeBrowse is React + ESM and NiiVue 1.0 ships bare-specifier ESM, so a
// static app cannot import either directly. Vite apps import
// `@neurodesk/runtime-support/freebrowse-viewer` and never use this bundle.
//
// The output is generated (git-ignored) and cached on a hash of its inputs,
// because static apps regenerate their runtime support before every test run.
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(packageRoot, 'src', 'freebrowse-viewer');
const cacheDir = join(packageRoot, 'dist', 'freebrowse-viewer');
const stampFile = join(cacheDir, '.inputs.sha256');

async function inputHash() {
  const hash = createHash('sha256');
  const inputs = [
    ...(await readdir(sourceDir)).sort().map((name) => join(sourceDir, name)),
    join(packageRoot, 'package.json'),
    fileURLToPath(import.meta.url),
    join(packageRoot, '..', 'components', 'src', 'styles', 'imaging-workspace.css'),
    join(packageRoot, 'node_modules', 'freebrowse', 'package.json'),
    join(packageRoot, 'node_modules', '@niivue', 'niivue', 'package.json'),
  ];
  for (const input of inputs) hash.update(await readFile(input));
  return hash.digest('hex');
}

export async function buildFreebrowseViewer() {
  const wanted = await inputHash();
  const current = await readFile(stampFile, 'utf8').catch(() => '');
  if (current === wanted) return cacheDir;
  const { build } = await import('vite');
  await rm(cacheDir, { recursive: true, force: true });
  await build({
    configFile: false,
    root: packageRoot,
    logLevel: 'warn',
    define: { 'process.env.NODE_ENV': '"production"' },
    worker: { format: 'es' },
    build: {
      target: 'es2022',
      outDir: cacheDir,
      emptyOutDir: true,
      assetsInlineLimit: 0,
      lib: {
        entry: join(sourceDir, 'static.js'),
        formats: ['es'],
        fileName: () => 'index.js',
      },
    },
  });
  await writeFile(stampFile, wanted);
  return cacheDir;
}

// Copies the bundle next to a static app's other generated runtime files.
export async function vendorFreebrowseViewer(destination) {
  const built = await buildFreebrowseViewer();
  await rm(destination, { recursive: true, force: true });
  await mkdir(destination, { recursive: true });
  await cp(built, destination, {
    recursive: true,
    filter: (source) => !source.endsWith('.inputs.sha256'),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(`FreeBrowse viewer bundle -> ${await buildFreebrowseViewer()}`);
}
