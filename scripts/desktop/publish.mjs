import { readDraftRelease } from '../lib/github-release.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { signingEnabled, verifyWindowsArchive } from './windows-signing.mjs';
import { renderInstallationNotes } from './release-notes.mjs';
import { fileHash } from '../../packages/desktop/src/bundle.js';
import { catalogApps, loadAppsRegistry } from '../lib/apps-registry.mjs';
import { loadStandalone } from '../lib/standalone.mjs';
import { recordUrls, reusePlan } from '../lib/release-reuse.mjs';
import { suiteCatalog, suitePlatforms, suiteTag } from './suite.mjs';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({ allowPositionals: true, options: { catalog: { type: 'string' }, 'prepare-only': { type: 'boolean' } } });
const directory = resolve(positionals[0] || 'release-artifacts');
const registry = await loadAppsRegistry();
const catalog = suiteCatalog(registry, options.catalog);
const { desktop } = catalog;
const apps = catalogApps(registry, catalog);
const standalone = await loadStandalone(registry);
const version = JSON.parse(await readFile('packages/desktop/package.json')).version;
const tag = suiteTag(catalog, version);
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
const platforms = suitePlatforms(registry, catalog);
const container = platforms.includes('linux-x64-apptainer');
const uploads = new Set();
async function releaseRecord(platform) {
  const path = find(`${platform}.json`);
  const metadata = JSON.parse(await readFile(path));
  if (metadata.version !== version || metadata.platform !== platform) throw new Error(`Incomplete ${platform}`);
  const primary = find(basename(new URL(metadata.url).pathname));
  if (await fileHash(primary) !== metadata.sha256) throw new Error(`Corrupt ${primary}`);
  const built = [primary, path];
  const complete = createHash('sha256');
  for (const part of metadata.parts || []) {
    const partPath = find(part.filename);
    if (await fileHash(partPath) !== part.sha256) throw new Error(`Corrupt ${partPath}`);
    for await (const chunk of createReadStream(partPath)) complete.update(chunk);
    built.push(partPath);
  }
  if (metadata.parts && complete.digest('hex') !== metadata.archiveSha256) throw new Error(`Reassembled checksum differs for ${platform}`);
  if (platform === 'windows-x64' && signingEnabled()) {
    const archiveHash = metadata.archiveSha256 || metadata.sha256;
    if (metadata.windowsSigning?.verified !== true || metadata.windowsSigning.archiveSha256 !== archiveHash) throw new Error('Windows release lacks archive-bound signing verification');
    if (!metadata.parts) verifyWindowsArchive(primary, desktop.executable);
    else {
      const temporary = await mkdtemp(join(tmpdir(), 'desktop-signature-check-'));
      try {
        const archive = join(temporary, metadata.archiveFilename);
        async function* chunks() {
          for (const part of metadata.parts) yield* createReadStream(find(part.filename));
        }
        await pipeline(chunks(), createWriteStream(archive));
        verifyWindowsArchive(archive, desktop.executable);
      } finally { await rm(temporary, { recursive: true, force: true }); }
    }
  }
  return { metadata, built };
}
const available = async urls => {
  for (const url of urls) {
    const response = await fetch(url, { method: 'HEAD' }).catch(() => null);
    if (!response?.ok) return false;
  }
  return true;
};
const entries = [];
for (const platform of platforms) entries.push(await releaseRecord(platform));
entries.push(await releaseRecord('any'));
if (entries.at(-1).metadata.kind !== 'models') throw new Error('The platform-independent model pack is missing');
const published = [];
for (const [index, { record, candidate }] of reusePlan(standalone.suites?.[catalog.id], entries.map(entry => entry.metadata)).entries()) {
  if (candidate && await available(recordUrls(candidate))) {
    console.log(`Reusing the published ${record.platform} ${record.kind} from ${candidate.version}`);
    published.push(candidate);
    continue;
  }
  if (candidate) console.log(`The published ${record.platform} ${record.kind} is unavailable, so its bytes are uploaded again`);
  for (const path of entries[index].built) uploads.add(path);
  published.push(record);
}
const downloads = published.slice(0, platforms.length);
const models = published.at(-1);
const expectedApps = apps.map(app => app.id).sort();
async function checkReport(artifact, report, { complete }) {
  const matching = files.filter(path => path.includes(`${artifact}/`) && path.endsWith(`/${report}/startup.json`));
  if (matching.length !== 1) throw new Error(`Missing ${report} from ${artifact}`);
  const results = JSON.parse(await readFile(matching[0]));
  if (results.some(result => !result.passed)) throw new Error(`Failed ${report} in ${artifact}`);
  if (complete && JSON.stringify(results.map(result => result.app).sort()) !== JSON.stringify(expectedApps)) throw new Error(`Incomplete ${report} in ${artifact}`);
  return results;
}
for (const os of ['ubuntu-22.04', 'macos-15', 'windows-latest']) await checkReport(`desktop-${catalog.id}-${os}`, 'packaged-desktop-reports', { complete: true });
if (container && !files.some(path => path.includes(`desktop-${catalog.id}-ubuntu-22.04/`) && path.endsWith('/container-reports/batch.json'))) throw new Error('Missing HPC batch tests');
// The pack replaces the model-inclusive edition, so a networkless run against
// an extracted pack is the evidence that offline installations still work.
const offline = await checkReport(`desktop-${catalog.id}-models-offline`, 'desktop-workflow-reports', { complete: false });
if (!offline.some(result => result.workflow)) throw new Error('The offline model pack test ran no workflow');
if (offline.some(result => result.downloaded !== 0)) throw new Error('The offline model pack test downloaded a model instead of reading the pack');
const suiteApps = await Promise.all(apps.map(async app => ({ id: app.id, version: JSON.parse(await readFile(`apps/${app.id}/package.json`)).version })));
standalone.suites = { ...standalone.suites, [catalog.id]: { version, revision, apps: suiteApps, downloads, models } };
const metadataPath = join(directory, 'standalone-catalog.json');
await writeFile(metadataPath, `${JSON.stringify(standalone, null, 2)}\n`);
uploads.add(metadataPath);
const notesPath = join(directory, 'release-notes.md');
const apptainer = container ? ' The Apptainer SIF supports HPC GUI sessions and JSON batch jobs.' : '';
const batch = container ? ', and a Docker batch job with networking disabled' : '';
await writeFile(notesPath, `# ${desktop.product_name} ${version}\n\nAll ${apps.length} applications of ${catalog.title} (${catalog.host}) ship in one archive per platform. It downloads and caches a model the first time that model is needed. The separate model pack holds every model of these applications for every platform. Install the pack when the machine has no internet access, or share one extracted copy across an HPC cluster.\n\nDownload every archive part for your platform and its installation instructions. macOS targets Apple silicon; Linux and Windows target x86-64.${apptainer} WebGPU methods require compatible GPU hardware.\n\nEvery installed application was launched with a fresh profile on macOS, Linux and Windows. CI also tested offline computations and exports against an extracted model pack with networking denied${batch}. Model accuracy and hardware-specific GPU coverage are documented in the repository test reports.\n\nSource: ${revision}\n\n${renderInstallationNotes(downloads, models, desktop)}`);
if (options['prepare-only']) {
  console.log(metadataPath);
} else {
  const existing = readDraftRelease(gh, tag);
  if (existing && !existing.isDraft) throw new Error('Refusing to replace an already published release');
  if (!existing) gh(['release', 'create', tag, '--draft', '--target', revision, '--title', `${desktop.product_name} ${version}`, '--notes-file', notesPath]);
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
