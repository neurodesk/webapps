import { execFileSync } from 'node:child_process';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { renderInstallationNotes } from './release-notes.mjs';
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
const uploads = new Set();
async function releaseRecord(platform) {
  const path = find(`${platform}.json`);
  const metadata = JSON.parse(await readFile(path));
  if (metadata.version !== version || metadata.platform !== platform) throw new Error(`Incomplete ${platform}`);
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
  uploads.add(path);
  return metadata;
}
const downloads = [];
for (const platform of platforms) downloads.push(await releaseRecord(platform));
const models = await releaseRecord('any');
if (models.kind !== 'models') throw new Error('The platform-independent model pack is missing');
const expectedApps = registry.apps.map(app => app.id).sort();
async function checkReport(artifact, report, { complete }) {
  const matching = files.filter(path => path.includes(`${artifact}/`) && path.endsWith(`/${report}/startup.json`));
  if (matching.length !== 1) throw new Error(`Missing ${report} from ${artifact}`);
  const results = JSON.parse(await readFile(matching[0]));
  if (results.some(result => !result.passed)) throw new Error(`Failed ${report} in ${artifact}`);
  if (complete && JSON.stringify(results.map(result => result.app).sort()) !== JSON.stringify(expectedApps)) throw new Error(`Incomplete ${report} in ${artifact}`);
  return results;
}
for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) await checkReport(`desktop-${os}`, 'packaged-desktop-reports', { complete: true });
if (!files.some(path => path.includes('desktop-ubuntu-22.04/') && path.endsWith('/container-reports/batch.json'))) throw new Error('Missing HPC batch tests');
// The pack replaces the model-inclusive edition, so a networkless run against
// an extracted pack is the evidence that offline installations still work.
const offline = await checkReport('desktop-models-offline', 'desktop-workflow-reports', { complete: false });
if (!offline.some(result => result.workflow)) throw new Error('The offline model pack test ran no workflow');
catalog.suite = { version, revision, apps: await Promise.all(registry.apps.map(async app => ({ id: app.id, version: JSON.parse(await readFile(`apps/${app.id}/package.json`)).version }))), downloads, models };
const metadataPath = join(directory, 'standalone-catalog.json');
await writeFile(metadataPath, `${JSON.stringify(catalog, null, 2)}\n`);
uploads.add(metadataPath);
const notesPath = join(directory, 'release-notes.md');
await writeFile(notesPath, `# Neurodesk Webapps ${version}\n\nAll ${registry.apps.length} applications ship in one archive per platform. It downloads and caches a model the first time that model is needed. The separate model pack holds every model for every platform. Install the pack when the machine has no internet access, or share one extracted copy across an HPC cluster.\n\nDownload every archive part for your platform and its installation instructions. macOS targets Apple silicon; Linux and Windows target x86-64. The Apptainer SIF supports HPC GUI sessions and JSON batch jobs. WebGPU methods require compatible GPU hardware.\n\nEvery installed application was launched with a fresh profile on macOS, Linux and Windows. CI also tested offline computations and exports against an extracted model pack with networking denied, and a Docker batch job with networking disabled. Model accuracy and hardware-specific GPU coverage are documented in the repository test reports.\n\nSource: ${revision}\n\n${renderInstallationNotes(downloads, models)}`);
if (process.argv.includes('--prepare-only')) {
  console.log(metadataPath);
} else {
  let existing;
  try { existing = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft'])); } catch {}
  if (existing && !existing.isDraft) throw new Error('Refusing to replace an already published release');
  if (!existing) gh(['release', 'create', tag, '--draft', '--target', revision, '--title', `Neurodesk Webapps ${version}`, '--notes-file', notesPath]);
  // The release-asset API returns transient 500s under load, and each suite
  // carries gigabytes per platform. Resume completed uploads and retry the rest.
  const uploaded = new Map(JSON.parse(gh(['release', 'view', tag, '--json', 'assets'])).assets.map(asset => [asset.name, asset.size]));
  for (const path of uploads) {
    const name = basename(path);
    const { size } = await stat(path);
    if (uploaded.get(name) === size) {
      console.log(`Keeping ${name}`);
      continue;
    }
    for (let attempt = 1; ; attempt += 1) {
      console.log(`Uploading ${name}`);
      try {
        gh(['release', 'upload', tag, path, '--clobber']);
        break;
      } catch (error) {
        if (attempt === 5) throw error;
        console.log(`Upload failed (${error.message.trim().split('\n')[0]}); retrying in ${attempt * 30} s`);
        await setTimeout(attempt * 30000);
      }
    }
  }
  gh(['release', 'edit', tag, '--draft=false', '--latest=false']);
  console.log(`Published ${tag}`);
}
