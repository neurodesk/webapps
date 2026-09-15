import { cp, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot, loadAppsRegistry } from './apps-registry.mjs';

export async function loadStandalone(registry, root = repoRoot) {
  const value = JSON.parse(await readFile(join(root, 'registry/standalone.json'), 'utf8'));
  if (value.schema_version !== 1) throw new Error('Unsupported standalone catalog');
  const actual = Object.keys(value.apps).sort();
  const expected = registry.apps.map(app => app.id).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Standalone catalog must cover every registered app exactly once');
  for (const [id, app] of Object.entries(value.apps)) {
    if (app.desktop !== true) throw new Error(`${id}: desktop support is required`);
    if (!['interactive', 'batch'].includes(app.profile)) throw new Error(`${id}: declare an execution profile`);
    for (const key of ['assets', 'downloads', 'containers']) {
      if (!Array.isArray(app[key])) throw new Error(`${id}: missing ${key}`);
    }
    for (const download of app.downloads) {
      if (!/^https:\/\/github\.com\/neurodesk\/webapps\/releases\/download\//.test(download.url)) throw new Error(`${id}: invalid download URL`);
      if (!/^[a-f0-9]{64}$/.test(download.sha256)) throw new Error(`${id}: download must have a checksum`);
      if (!download.platform || !download.version || !download.kind) throw new Error(`${id}: incomplete release metadata`);
    }
  }
  return value;
}

export async function stageStandaloneAssets(destination) {
  await loadStandalone(await loadAppsRegistry());
  await cp(join(repoRoot, 'registry/standalone.json'), join(destination, 'standalone.json'));
  const components = join(destination, 'shell-adapters/components');
  for (const directory of ['core', 'ui', 'styles']) await mkdir(join(components, directory), { recursive: true });
  for (const name of ['core/dom.js', 'ui/renderInfoDialog.js', 'ui/renderStandalone.js', 'styles/imaging-workspace.css', 'styles/base.css']) {
    await cp(join(repoRoot, 'packages/components/src', name), join(components, name));
  }
}
