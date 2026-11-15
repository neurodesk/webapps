import { EMBEDDED_VERSION_SITES } from './embedded-version-sites.mjs';
import { onlyBumpsVersion } from './module-closure.mjs';

// What `pnpm release` writes without changing what any app, package or
// command line does: changelogs, workspace manifests that only gained a
// version, and the version strings registered in EMBEDDED_VERSION_SITES.
// workspace-contracts (test/app-versions.test.mjs) checks that these agree on
// every run, so no app, native suite or site build has to run for them.

const CHANGELOG = /(?:^|\/)CHANGELOG\.md$/;
const WORKSPACE_MANIFEST = /^(?:apps|packages|exes)\/[^/]+\/package\.json$/;

const SITES = new Map();
for (const sites of Object.values(EMBEDDED_VERSION_SITES)) {
  for (const site of sites) SITES.set(site.file, [...(SITES.get(site.file) ?? []), site]);
}

// Files whose base and head text the bookkeeping check reads.
export const EMBEDDED_VERSION_FILES = new Set(SITES.keys());

// The text with every registered version site of `file` blanked.
function withoutVersions(file, text) {
  return SITES.get(file).reduce((current, site) => current.replace(site.pattern, site.replace.replace('{version}', '')), text);
}

// Why `path` is release bookkeeping, or null. `manifests` maps changed paths to
// their { before, after } text (changedManifests in app-plan.mjs).
export function releaseBookkeeping(path, manifests) {
  if (CHANGELOG.test(path)) return 'a changelog';
  const manifest = manifests.get(path);
  if (!manifest?.before || !manifest?.after) return null;
  if (WORKSPACE_MANIFEST.test(path) && onlyBumpsVersion(manifest)) return 'only its version changed';
  if (SITES.has(path) && manifest.before !== manifest.after
    && withoutVersions(path, manifest.before) === withoutVersions(path, manifest.after)) return 'only its embedded app version changed';
  return null;
}
