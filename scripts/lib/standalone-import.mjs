// Turn a released GitHub release into the Standalone catalog's command-line downloads.
// Never guess URLs: every entry comes from an uploaded asset, GitHub's own digest and a validation receipt.
// An app can have several release sources (scripts/lib/native-releases.mjs). Each owns its platforms and
// can version independently, so an update replaces and version-checks only the platforms of the source it
// came from.
import { portableCommand, releasePlatform } from './portable-command.mjs';

export const RELEASE_ARGUMENT = /^([a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d{8})$/;
const RELEASE_TAG = /^([a-z0-9][a-z0-9-]*)-v(\d+\.\d+\.\d{8})$/;

export function parseReleases(values) {
  return values.map((value) => {
    const match = RELEASE_ARGUMENT.exec(value.trim());
    if (!match) throw new Error(`Expected app@MAJOR.MINOR.YYYYMMDD, got ${value}`);
    return { id: match[1], version: match[2] };
  });
}

export function releaseFromTag(tag) {
  const match = RELEASE_TAG.exec(tag);
  return match ? { id: match[1], version: match[2] } : null;
}

// The one version the catalog lists for these platforms' command lines, or null when it lists none.
function listedVersion(id, platforms, downloads) {
  const owned = downloads.filter((download) => download.kind === 'cli' && platforms.includes(download.platform));
  const versions = [...new Set(owned.map((download) => download.version))];
  if (versions.length > 1) throw new Error(`${id}: command-line downloads for ${platforms.join(', ')} mix versions ${versions.join(', ')}`);
  return versions[0] ?? null;
}

// The release each source's catalog entries currently point at, so a refresh needs no hard-coded versions.
export function catalogReleases(catalog, natives) {
  return Object.entries(catalog.apps).flatMap(([id, app]) => {
    const sources = natives.get(id) ?? [];
    const unowned = app.downloads.filter((download) => download.kind === 'cli' && !sources.some((source) => source.targets.includes(download.platform)));
    if (unowned.length) throw new Error(`${id}: no release source builds ${unowned.map((download) => download.platform).join(', ')}`);
    return sources.flatMap((source) => {
      const version = listedVersion(id, source.targets, app.downloads);
      return version ? [{ id, version }] : [];
    });
  });
}

// The sources whose archives a release carries. Sources can attach to one shared tag or to their own.
export function releaseSources(sources, release) {
  return sources.filter((source) => release.assets.some((asset) => source.targets.includes(releasePlatform(source.spec, asset.name))));
}

// The archive digests a receipt records: "archive_sha256=DIGEST" (exes/node-cli), "sha256: DIGEST"
// (SynthSR), and "sha256: DIGEST  FILE" or a shasum line "DIGEST  FILE" (Greedy, SynthSEG). A line that names
// a file counts only when the file is this archive, so a receipt renamed from another archive records nothing.
function recordedDigests(text, name) {
  const digests = [];
  for (const line of text.split('\n')) {
    const match = /^(?:archive_sha256=|sha256:\s*)?([a-f0-9]{64})(?:\s+[ *]?(\S+))?\s*$/.exec(line.trim());
    if (!match) continue;
    const [, digest, file] = match;
    const labelled = /^(?:archive_sha256=|sha256:)/.test(line.trim());
    if (file ? file.split('/').at(-1) === name : labelled) digests.push(digest);
  }
  return digests;
}

// A receipt must vouch for these exact bytes: it records this archive's digest, and no other digest for it.
// exes/node-cli receipts also open with "PASS <target>". The Rust tools' receipts otherwise vary (SynthSR's
// lists an expected "webgpu: FAILED" on GPU-less runners).
export function checkReceipt({ name, digest, platform, native, text: raw }) {
  const text = raw.replace(/\r\n/g, '\n');
  const recorded = recordedDigests(text, name);
  if (recorded.some((value) => value !== digest)) throw new Error(`${name}: its receipt validated different bytes`);
  if (!recorded.length) throw new Error(`${name}: its receipt records no SHA-256 of the archive`);
  if (native.startsWithAppRelease && !text.startsWith(`PASS ${platform}\n`)) throw new Error(`${name}: its receipt does not pass these exact bytes`);
}

// The file-name stem of a source's archives: the portable executable's name (FLAMeS ships as flames-...),
// otherwise the app id.
function archiveStem(id, spec, platform) {
  return spec ? spec.targets[platform].executable.replace(/\.exe$/, '') : id;
}

// Only a released (not draft, not prerelease) GitHub release with every target of its source verified is
// published, one archive per platform, each named for the release's own version.
export async function releaseDownloads({ id, version, release, native, previous = [], fetchText }) {
  if (release.draft || release.prerelease) throw new Error(`${id}: release ${release.tag_name} is not released yet`);
  const spec = native.spec;
  const embeddedModels = previous.some((download) => download.kind === 'cli' && native.targets.includes(download.platform) && download.modelsIncluded);
  const downloads = [];
  for (const asset of release.assets) {
    const platform = releasePlatform(spec, asset.name);
    if (!native.targets.includes(platform)) continue;
    const expected = `${archiveStem(id, spec, platform)}-${version}-${platform}.`;
    if (!asset.name.startsWith(expected)) throw new Error(`${asset.name}: release ${release.tag_name} expects ${expected}* for ${platform}`);
    if (downloads.some((download) => download.platform === platform)) throw new Error(`${id}: release ${release.tag_name} has two ${platform} archives`);
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error(`${asset.name}: GitHub has no asset digest`);
    const receipt = release.assets.find((item) => item.name === `${asset.name}.validation.txt`);
    if (!receipt) throw new Error(`${asset.name}: no validation receipt, so the archive was never verified`);
    checkReceipt({ name: asset.name, digest: asset.digest.slice(7), platform, native, text: await fetchText(receipt.browser_download_url) });
    downloads.push({
      kind: 'cli',
      platform,
      version,
      url: asset.browser_download_url,
      sha256: asset.digest.slice(7),
      bytes: asset.size,
      validationUrl: receipt.browser_download_url,
      ...(spec ? { modelsIncluded: true, command: portableCommand(spec, platform, asset.name) } : {}),
      ...(!spec && embeddedModels ? { modelsIncluded: true } : {}),
    });
  }
  const missing = native.targets.filter((platform) => !downloads.some((download) => download.platform === platform));
  if (missing.length) throw new Error(`${id}: release ${release.tag_name} lacks ${missing.join(', ')}`);
  return downloads;
}

// The catalog changes for a set of releases, as [{ id, version, downloads }], one entry per source whose
// archives a release carries; each such source must have every one of its targets verified. A one-source
// app is held to its targets even before any archive is attached. Nothing is written here.
export async function catalogUpdate(catalog, releases, { fetchRelease, fetchText, nativeAt }) {
  const update = [];
  for (const { id, version } of releases) {
    if (!catalog.apps[id]) throw new Error(`${id}: not in the Standalone catalog`);
    const tag = `${id}-v${version}`;
    const sources = nativeAt(tag).get(id) ?? [];
    if (!sources.length) throw new Error(`${id}: ${tag} ships no native command line`);
    const release = await fetchRelease(tag);
    const built = sources.length === 1 ? sources : releaseSources(sources, release);
    if (!built.length) throw new Error(`${id}: release ${tag} has no command-line archives`);
    for (const native of built) {
      const downloads = await releaseDownloads({ id, version, release, native, previous: catalog.apps[id].downloads, fetchText });
      update.push({ id, version, downloads });
    }
  }
  return update;
}

// Publishers re-upload with --clobber, so an update computed before a re-upload names bytes the release no
// longer serves. The publish job calls this just before each commit; a changed asset stops the commit, and
// the run that re-uploaded it publishes its own update.
export async function checkUpdateAssets(update, fetchRelease) {
  for (const { id, version, downloads } of update) {
    const tag = `${id}-v${version}`;
    const release = await fetchRelease(tag);
    for (const download of downloads) {
      const name = download.url.split('/').at(-1);
      const asset = release.assets.find((item) => item.name === name);
      const same = asset
        && asset.browser_download_url === download.url
        && asset.digest === `sha256:${download.sha256}`
        && asset.size === download.bytes;
      if (!same) throw new Error(`${name}: release ${tag} no longer serves the bytes this update verified`);
    }
  }
}

function versionKey(version) {
  return version.split('.').map(Number);
}

export function compareVersions(a, b) {
  const [left, right] = [versionKey(a), versionKey(b)];
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

// Replaces only the platforms each release's source owns and keeps every other download.
// Catalog runs are not serialised, so a slow run for an older release must not replace a newer one of the
// same source. Another source's version is never compared: the sources number their releases independently.
export function applyCatalogUpdate(catalog, update) {
  if (!Array.isArray(update)) throw new Error('A catalog update is a list of { id, version, downloads } releases');
  for (const { id, version, downloads } of update) {
    const app = catalog.apps[id];
    if (!app) throw new Error(`${id}: not in the Standalone catalog`);
    const platforms = downloads.map((download) => download.platform);
    const current = listedVersion(id, platforms, app.downloads);
    if (current && compareVersions(version, current) < 0) {
      console.log(`${id}: catalog already lists ${current} for ${platforms.join(', ')}; keeping it over ${version}`);
      continue;
    }
    const kept = app.downloads.filter((download) => !(download.kind === 'cli' && platforms.includes(download.platform)));
    app.downloads = [...kept, ...downloads].sort((a, b) => (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0));
  }
  return catalog;
}
