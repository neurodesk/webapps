import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeCoiServiceWorker } from './runtime-support.mjs';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const binaryTypes = new Map([
  ['.wasm', 'application/wasm'],
  ['.onnx', 'application/octet-stream'],
  ['.data', 'application/octet-stream'],
  ['.bin', 'application/octet-stream'],
]);
const excludedDirectory = /^(?:examples?|fixtures?|patients?|inputs?|outputs?|downloads?|test(?:s)?|\.git)$/i;

async function binaryFiles(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !excludedDirectory.test(entry.name)) await binaryFiles(path, files);
    else if (entry.isFile() && binaryTypes.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

async function assetEntry(file, distDir) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const path = relative(distDir, file).split(sep).map(encodeURIComponent).join('/');
  return {
    url: path.startsWith('.') ? path : `./${path}`,
    sha256: hash.digest('hex'),
    bytes: (await stat(file)).size,
    contentType: binaryTypes.get(extname(file).toLowerCase()),
  };
}

async function directoryAssets(directory) {
  const assets = [];
  for (const file of (await binaryFiles(directory)).sort()) assets.push(await assetEntry(file, directory));
  return assets;
}

export async function writeRuntimeCacheManifest({ distDir, sharedDir, sharedAssets }) {
  const assets = await directoryAssets(distDir);
  if (sharedDir) {
    const prefix = relative(distDir, sharedDir).split(sep).map(encodeURIComponent).join('/');
    for (const asset of sharedAssets ?? await directoryAssets(sharedDir)) {
      assets.push({ ...asset, url: `${prefix}/${asset.url.slice(2)}` });
    }
  }
  assets.sort((left, right) => left.url.localeCompare(right.url));
  const manifest = { schema_version: 1, assets };
  const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestName = `runtime-cache-manifest.${createHash('sha256').update(serialized).digest('hex')}.json`;
  await writeFile(join(distDir, manifestName), serialized);
  await rm(join(distDir, 'runtime-cache-manifest.json'), { force: true });

  const workerPath = join(distDir, 'coi-serviceworker.js');
  let config = {};
  try {
    const previous = await readFile(workerPath, 'utf8');
    const rendered = previous.match(/const coiRuntimeConfig = (\{[^\n]*\});/);
    if (rendered) config = JSON.parse(rendered[1]);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await writeCoiServiceWorker({
    repoRoot,
    destination: workerPath,
    config: { ...config, alwaysRegister: true, runtimeCache: true },
  });
  const indexPath = join(distDir, 'index.html');
  let html;
  try {
    html = await readFile(indexPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return manifest;
  }
  const marker = `<meta name="neurodesk-runtime-manifest" content="./${manifestName}">`;
  html = html.replace(/<meta\b[^>]*\bname=["']neurodesk-runtime-manifest["'][^>]*>\s*/gi, '');
  html = html.replace(/<head\b[^>]*>/i, `$&\n${marker}`);
  if (!/<script\b[^>]*\bsrc\s*=\s*["'][^"']*coi-serviceworker\.js(?:\?[^"']*)?["']/i.test(html)) {
    html = html.replace(marker, `${marker}\n<script src="./coi-serviceworker.js"></script>`);
  }
  await writeFile(indexPath, html);
  return manifest;
}

export async function writeCompositeRuntimeCacheManifests({ siteDist, registry }) {
  const sharedDir = join(siteDist, '_runtime');
  const sharedAssets = await directoryAssets(sharedDir);
  for (const app of registry.apps) {
    await writeRuntimeCacheManifest({ distDir: join(siteDist, app.path), sharedDir, sharedAssets });
  }
}
