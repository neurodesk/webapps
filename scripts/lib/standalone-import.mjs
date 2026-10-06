// Turn a published GitHub release into the Standalone catalog's command-line downloads.
// Never guess URLs: every entry comes from an uploaded asset and GitHub's own digest.
import { portableCommand, releasePlatform } from './portable-command.mjs';

export const RELEASE_ARGUMENT = /^([a-z0-9][a-z0-9-]*)@(\d+\.\d+\.\d{8})$/;

export function parseReleases(values) {
  return values.map((value) => {
    const match = RELEASE_ARGUMENT.exec(value.trim());
    if (!match) throw new Error(`Expected app@MAJOR.MINOR.YYYYMMDD, got ${value}`);
    return { id: match[1], version: match[2] };
  });
}

// The release each app's catalog entry currently points at, so a refresh needs no hard-coded versions.
export function catalogReleases(catalog) {
  return Object.entries(catalog.apps).flatMap(([id, app]) => {
    const versions = [...new Set(app.downloads.filter((download) => download.kind === 'cli').map((download) => download.version))];
    if (versions.length > 1) throw new Error(`${id}: command-line downloads mix versions ${versions.join(', ')}`);
    return versions.map((version) => ({ id, version }));
  });
}

export function releaseDownloads({ id, version, release, spec, previous = [] }) {
  if (release.draft) throw new Error(`${id}: release ${release.tag_name} is still a draft`);
  const embeddedModels = previous.some((download) => download.kind === 'cli' && download.modelsIncluded);
  const downloads = release.assets.flatMap((asset) => {
    const platform = releasePlatform(spec, asset.name);
    if (!platform) return [];
    if (!/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error(`${asset.name}: GitHub has no asset digest`);
    const receipt = release.assets.find((item) => item.name === `${asset.name}.validation.txt`);
    if (spec && !receipt) throw new Error(`${asset.name}: no validation receipt, so the archive was never verified`);
    return [{
      kind: 'cli',
      platform,
      version,
      url: asset.browser_download_url,
      sha256: asset.digest.slice(7),
      bytes: asset.size,
      ...(receipt ? { validationUrl: receipt.browser_download_url } : {}),
      ...(spec ? { modelsIncluded: true, command: portableCommand(spec, platform, asset.name) } : {}),
      ...(!spec && embeddedModels ? { modelsIncluded: true } : {}),
    }];
  });
  if (!downloads.length) throw new Error(`${id}: release ${release.tag_name} has no native archives`);
  if (spec) {
    const missing = Object.keys(spec.targets).filter((platform) => !downloads.some((download) => download.platform === platform));
    if (missing.length) throw new Error(`${id}: release ${release.tag_name} lacks ${missing.join(', ')}`);
  }
  return downloads;
}

export async function importReleases(catalog, releases, { fetchRelease, specs }) {
  for (const { id, version } of releases) {
    if (!catalog.apps[id]) throw new Error(`${id}: not in the Standalone catalog`);
    const release = await fetchRelease(`${id}-v${version}`);
    const spec = specs.get(id)?.spec ?? null;
    catalog.apps[id].downloads = releaseDownloads({ id, version, release, spec, previous: catalog.apps[id].downloads });
  }
  return catalog;
}
