import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot, loadAppsRegistry } from './apps-registry.mjs';

export async function loadStandalone(registry, root = repoRoot) {
  return validateStandalone(JSON.parse(await readFile(join(root, 'registry/standalone.json'), 'utf8')), registry);
}

// Every themed app build runs this check on the whole catalog, so the CI
// planner runs it too before scoping a catalog change to the entries changed.
export function validateStandalone(value, registry) {
  if (value?.schema_version !== 1) throw new Error('Unsupported standalone catalog');
  const actual = Object.keys(value.apps).sort();
  const expected = registry.apps.map(app => app.id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Standalone catalog must cover every registered app exactly once');
  for (const [id, app] of Object.entries(value.apps)) {
    if (app.desktop !== true) throw new Error(`${id}: desktop support is required`);
    if (!['interactive', 'batch'].includes(app.profile)) throw new Error(`${id}: declare an execution profile`);
    for (const key of ['assets', 'downloads', 'containers']) {
      if (!Array.isArray(app[key])) throw new Error(`${id}: missing ${key}`);
    }
    validateDownloads(app.downloads, id);
    if (app.commandLine && (!Array.isArray(app.commandLine.notes) || !app.commandLine.links?.every(link => link.label && /^https:\/\//.test(link.url)))) throw new Error(`${id}: commandLine needs notes and https links`);
    if (app.computeServer) validateComputeServer(app.computeServer, id);
    if (app.openrecon && (typeof app.openrecon.label !== 'string' || !app.openrecon.label.trim() || typeof app.openrecon.recipe !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(app.openrecon.recipe))) {
      throw new Error(`${id}: OpenRecon requires a package label and recipe name`);
    }
  }
  if (value.suite) {
    validateDownloads(value.suite.downloads, 'suite');
    if (value.suite.models) validateDownloads([value.suite.models], 'suite model pack');
  }
  return value;
}

function validateDownloads(downloads, id) {
  if (!Array.isArray(downloads)) throw new Error(`${id}: missing downloads`);
  for (const download of downloads) {
    for (const file of [download, ...(download.parts || [])]) {
      // A GitHub release asset: this repository's, or an external release pinned in release.json.
      if (!/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/.test(file.url)) throw new Error(`${id}: invalid download URL`);
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`${id}: download must have a checksum`);
    }
    if (!download.platform || !download.version || !['desktop', 'cli', 'container', 'models'].includes(download.kind)) throw new Error(`${id}: incomplete release metadata`);
  }
}

// Shared modules the app shell imports at run time (Standalone dialog, page-wide drop, handoff sweep).
/** Build or checksum instructions the Standalone dialog must never show users. */
export const DIALOG_FORBIDDEN = /cargo build|compile from source|make macos-release|sha-256|sha256|shasum|Prepare this upstream/i;

export const SHELL_COMPONENTS = ['core/dom.js', 'ui/renderInfoDialog.js', 'ui/renderStandalone.js', 'ui/pageDrop.js', 'file-io/detectFiles.js', 'handoff/index.js', 'handoff/receive.js', 'styles/imaging-workspace.css', 'styles/base.css'];

export async function stageStandaloneAssets(destination) {
  await loadStandalone(await loadAppsRegistry());
  await cp(join(repoRoot, 'registry/standalone.json'), join(destination, 'standalone.json'));
  const components = join(destination, 'shell-adapters/components');
  for (const directory of ['core', 'ui', 'styles', 'file-io', 'handoff']) await mkdir(join(components, directory), { recursive: true });
  for (const name of SHELL_COMPONENTS) {
    await cp(join(repoRoot, 'packages/components/src', name), join(components, name));
  }
}

export function validateComputeServer(server, id) {
  if (server.name !== 'neurodesk-compute' || !/^https:\/\/github\.com\/neurodesk\/webapps\//.test(server.documentation)) throw new Error(`${id}: invalid compute server metadata`);
  if (!server.download) return;
  const file = server.download;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.tar\.gz$/.test(file.filename) || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || !/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`${id}: compute server download requires a safe filename, size and checksum`);
  const previewPath = `/${id}/downloads/${file.filename}`;
  if (file.preview === true) {
    if (file.url !== previewPath || file.checksumUrl !== `${previewPath}.sha256`) throw new Error(`${id}: preview compute download must use its own app path`);
  } else if (!/^https:\/\/github\.com\/neurodesk\/webapps\/releases\/download\//.test(file.url)) {
    throw new Error(`${id}: compute server release must use the verified release catalog`);
  }
}
