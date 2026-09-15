import { execFileSync } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { fileHash } from '../../packages/desktop/src/bundle.js';
import { loadAppsRegistry } from '../lib/apps-registry.mjs';
import { loadStandalone } from '../lib/standalone.mjs';

const directory = resolve(process.argv[2] || 'release-artifacts');
const registry = await loadAppsRegistry();
const catalog = await loadStandalone(registry);
const version = JSON.parse(await readFile('packages/desktop/package.json')).version;
const tag = `webapps-v${version}`;
const gh = args => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const revision = process.env.GITHUB_SHA || gh(['api', 'repos/neurodesk/webapps/commits/HEAD', '--jq', '.sha']);
const files = [];
async function visit(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await visit(child);
    else files.push(child);
  }
}
await visit(directory);
const find = name => {
  const matches = files.filter(path => basename(path) === name);
  if (matches.length !== 1) throw new Error(`Expected one ${name}, found ${matches.length}`);
  return matches[0];
};
const platforms = ['macos-arm64', 'linux-x64', 'windows-x64', 'linux-x64-apptainer'];
const downloads = [];
const uploads = new Set();
for (const modelsIncluded of [false, true]) {
  for (const platform of platforms) {
    const path = find(`${platform}${modelsIncluded ? '' : '-without-models'}.json`);
    const metadata = JSON.parse(await readFile(path));
    if (metadata.version !== version || metadata.modelsIncluded !== modelsIncluded) throw new Error(`Incomplete ${platform}`);
    const primary = find(basename(new URL(metadata.url).pathname));
    if (await fileHash(primary) !== metadata.sha256) throw new Error(`Corrupt ${primary}`);
    uploads.add(primary);
    const complete = createHash('sha256');
    for (const part of metadata.parts || []) {
      const partPath = find(part.filename);
      if (await fileHash(partPath) !== part.sha256) throw new Error(`Corrupt ${partPath}`);
      for await (const chunk of createReadStream(partPath)) complete.update(chunk);
      uploads.add(partPath);
    }
    if (metadata.parts && complete.digest('hex') !== metadata.archiveSha256) throw new Error(`Reassembled checksum differs for ${platform}`);
    downloads.push(metadata);
    uploads.add(path);
  }
}
for (const models of ['included', 'without']) {
  for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) {
    const matching = files.filter(path => path.includes(`desktop-${os}-${models}/`) && path.endsWith('/packaged-desktop-reports/startup.json'));
    if (matching.length !== 1) throw new Error(`Missing installed-app tests for ${os}`);
    const results = JSON.parse(await readFile(matching[0]));
    const expected = registry.apps.map(app => app.id).sort();
    if (JSON.stringify(results.map(result => result.app).sort()) !== JSON.stringify(expected) || results.some(result => !result.passed)) throw new Error(`Incomplete installed-app tests for ${os}`);
  }
  if (!files.some(path => path.includes(`desktop-ubuntu-22.04-${models}/`) && path.endsWith('/container-reports/batch.json'))) throw new Error(`Missing ${models} HPC batch tests`);
}
catalog.suite = { version, revision, apps: await Promise.all(registry.apps.map(async app => ({ id: app.id, version: JSON.parse(await readFile(`apps/${app.id}/package.json`)).version }))), downloads };
const metadataPath = join(directory, 'standalone-catalog.json');
await writeFile(metadataPath, `${JSON.stringify(catalog, null, 2)}\n`);
uploads.add(metadataPath);
const notesPath = join(directory, 'release-notes.md');
await writeFile(notesPath, `# Neurodesk Webapps ${version}\n\nAll ${registry.apps.length} applications are available in two editions. **Without models** downloads and caches models when needed. **Models included** bundles all model and runtime assets for offline use.\n\nDownload every archive part for your platform and its installation instructions. macOS targets Apple silicon; Linux and Windows target x86-64. The Apptainer SIF supports HPC GUI sessions and JSON batch jobs. WebGPU methods require compatible GPU hardware.\n\nEvery installed application was launched with a fresh profile on macOS, Linux and Windows. CI also tested offline computations and exports, and a Docker batch job with networking disabled. Model accuracy and hardware-specific GPU coverage are documented in the repository test reports.\n\nSource: ${revision}\n`);
if (process.argv.includes('--prepare-only')) {
  console.log(metadataPath);
} else {
  let existing;
  try { existing = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft'])); } catch {}
  if (existing && !existing.isDraft) throw new Error('Refusing to replace an already published release');
  if (!existing) gh(['release', 'create', tag, '--draft', '--target', revision, '--title', `Neurodesk Webapps ${version}`, '--notes-file', notesPath]);
  for (const path of uploads) {
    console.log(`Uploading ${basename(path)}`);
    gh(['release', 'upload', tag, path, '--clobber']);
  }
  gh(['release', 'edit', tag, '--draft=false', '--latest=false']);
  console.log(`Published ${tag}`);
}
