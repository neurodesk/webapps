#!/usr/bin/env node
// Manifest-driven runtime asset fetcher shared by the native-ESM apps. Replaces
// the per-app web/setup.sh download loops: names, versions, download URLs, and
// sha256 checksums all come from runtime-assets/manifest.json, so an app can
// only fetch runtime binaries the repo has pinned.
//
// Run via each app's `prebuild` script (pnpm sets cwd to the app package):
//   node ../../scripts/fetch-app-runtime.mjs --dest web/wasm \
//     ort-web:ort.min.js,ort-wasm-simd-threaded.mjs,ort-wasm-simd-threaded.wasm \
//     qsm-wasm:qsm_wasm.js,qsm_wasm_bg.wasm
//
// Each positional spec is <group-id>:<comma-separated file names>, resolved
// against the manifest's `families` and `downloads` entries (the group needs a
// `download_base`). Files already on disk with the pinned checksum are kept;
// downloads are verified against the pinned checksum before atomically
// replacing the destination. Stale `ort*` files in --dest that are not part of
// the request are removed so a loader-variant change cannot leave old ONNX
// Runtime entry points behind.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadBytes } from './lib/download-bytes.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const args = process.argv.slice(2);
const destIndex = args.indexOf('--dest');
if (destIndex === -1 || !args[destIndex + 1]) {
  console.error('Usage: fetch-app-runtime.mjs --dest <dir> <group>:<file,...> [...]');
  process.exit(1);
}
const dest = resolve(args[destIndex + 1]);
const specs = args.filter((arg, index) => index !== destIndex && index !== destIndex + 1 && !arg.startsWith('--'));
if (!specs.length) {
  console.error('No runtime files requested — pass at least one <group>:<file,...> spec');
  process.exit(1);
}

const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
if (manifest.schema_version !== 1) throw new Error('Unsupported runtime-assets manifest schema');
const groups = [...manifest.families, ...(manifest.downloads ?? [])];

const requested = [];
for (const spec of specs) {
  const separator = spec.indexOf(':');
  if (separator === -1) throw new Error(`Invalid spec '${spec}' — expected <group>:<file,...>`);
  const groupId = spec.slice(0, separator);
  const group = groups.find((candidate) => candidate.id === groupId);
  if (!group) throw new Error(`Unknown runtime group '${groupId}' in runtime-assets/manifest.json`);
  if (!group.download_base) throw new Error(`Runtime group '${groupId}' has no download_base — it cannot be fetched`);
  for (const name of spec.slice(separator + 1).split(',').filter(Boolean)) {
    const file = group.files.find((candidate) => candidate.name === name);
    if (!file) throw new Error(`${groupId}/${name} is not pinned in runtime-assets/manifest.json`);
    requested.push({
      group: groupId,
      name,
      sha256: file.sha256,
      url: `${group.download_base}/${name}`,
      version: group.version,
    });
  }
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function existingChecksum(path) {
  try {
    return sha256(await readFile(path));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

await mkdir(dest, { recursive: true });

for (const file of requested) {
  const target = join(dest, file.name);
  if (await existingChecksum(target) === file.sha256) {
    console.log(`  ${file.group}/${file.name} v${file.version} already up to date`);
    continue;
  }
  console.log(`  ${file.group}/${file.name} v${file.version} <- ${file.url}`);
  const data = await downloadBytes(file.url);
  const actual = sha256(data);
  if (actual !== file.sha256) {
    throw new Error(`Checksum mismatch for ${file.url}: expected ${file.sha256}, got ${actual}`);
  }
  const temporary = join(dest, `.download-${file.name}.${process.pid}`);
  await writeFile(temporary, data);
  await rename(temporary, target);
}

const requestedNames = new Set(requested.map((file) => file.name));
for (const entry of await readdir(dest)) {
  if (entry.startsWith('ort') && !requestedNames.has(entry)) {
    console.log(`  removing stale runtime file ${entry}`);
    await rm(join(dest, entry));
  }
}

console.log(`Verified ${requested.length} runtime files in ${dest}`);
