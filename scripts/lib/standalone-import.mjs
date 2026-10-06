// Turn a released GitHub release into the Standalone catalog's command-line downloads.
// Never guess URLs: every entry comes from an uploaded asset, GitHub's own digest and a validation receipt.
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

// The release each app's catalog entry currently points at, so a refresh needs no hard-coded versions.
export function catalogReleases(catalog) {
  return Object.entries(catalog.apps).flatMap(([id, app]) => {
    const versions = [...new Set(app.downloads.filter((download) => download.kind === 'cli').map((download) => download.version))];
    if (versions.length > 1) throw new Error(`${id}: command-line downloads mix versions ${versions.join(', ')}`);
    return versions.map((version) => ({ id, version }));
  });
}

// Only a released (not draft, not prerelease) GitHub release with every target verified is published.
export function releaseDownloads({ id, version, release, native, previous = [] }) {
  if (release.draft || release.prerelease) throw new Error(`${id}: release ${release.tag_name} is not released yet`);
  const spec = native.spec;
  const embeddedModels = previous.some((download) => download.kind === 'cli' && download.modelsIncluded);
  const downloads = release.assets.flatMap((asset) => {
    const platform = releasePlatform(spec, asset.name);
    if (!platform) return [];
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error(`${asset.name}: GitHub has no asset digest`);
    const receipt = release.assets.find((item) => item.name === `${asset.name}.validation.txt`);
    if (!receipt) throw new Error(`${asset.name}: no validation receipt, so the archive was never verified`);
    return [{
      kind: 'cli',
      platform,
      version,
      url: asset.browser_download_url,
      sha256: asset.digest.slice(7),
      bytes: asset.size,
      validationUrl: receipt.browser_download_url,
      ...(spec ? { modelsIncluded: true, command: portableCommand(spec, platform, asset.name) } : {}),
      ...(!spec && embeddedModels ? { modelsIncluded: true } : {}),
    }];
  });
  const missing = native.targets.filter((platform) => !downloads.some((download) => download.platform === platform));
  if (missing.length) throw new Error(`${id}: release ${release.tag_name} lacks ${missing.join(', ')}`);
  return downloads;
}

// The catalog changes for a set of releases, as { app: downloads }. Nothing is written here.
export async function catalogUpdate(catalog, releases, { fetchRelease, nativeAt }) {
  const update = {};
  for (const { id, version } of releases) {
    if (!catalog.apps[id]) throw new Error(`${id}: not in the Standalone catalog`);
    const tag = `${id}-v${version}`;
    const native = nativeAt(tag).get(id);
    if (!native) throw new Error(`${id}: ${tag} ships no native command line`);
    const release = await fetchRelease(tag);
    update[id] = releaseDownloads({ id, version, release, native, previous: catalog.apps[id].downloads });
  }
  return update;
}

export function applyCatalogUpdate(catalog, update) {
  for (const [id, downloads] of Object.entries(update)) {
    if (!catalog.apps[id]) throw new Error(`${id}: not in the Standalone catalog`);
    catalog.apps[id].downloads = downloads;
  }
  return catalog;
}
