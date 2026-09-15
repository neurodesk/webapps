import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './apps-registry.mjs';

// Apps predating the example contract are migrated by removing their entry here.
const legacyApps = new Set([
  'musclemap', 'vesselboost', 'spinalcordtoolbox', 'calmar', 'qsmbly', 'seedseg',
  'dicompare', 'deface', 'easy-mp2rage', 'niimath', 'dicom2vid', 'browserqc',
  'surfannotate', 'zarro', 'synthsr', 'synthseg', 'syncro', 'dwi2trx', 'edgereg',
  'greedy', 'ants', 'brain2print', 'topofit', 'fireants',
]);

export async function loadAppExamples(app, root = repoRoot) {
  let examples;
  try {
    examples = JSON.parse(await readFile(join(root, 'apps', app.id, 'examples.json'), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT' && legacyApps.has(app.id)) return null;
    throw new Error(`${app.id}: provide examples.json with a working, pinned example`, { cause: error });
  }
  if (!Array.isArray(examples) || examples.length === 0) {
    throw new Error(`${app.id}: examples.json must contain at least one example`);
  }
  const ids = new Set();
  for (const example of examples) {
    if (!/^[a-z][a-z0-9-]*$/.test(example.id ?? '') || ids.has(example.id)) {
      throw new Error(`${app.id}: examples need unique lowercase ids`);
    }
    ids.add(example.id);
    if (typeof example.label !== 'string' || !example.label.trim() || /TODO|placeholder/i.test(example.label)) {
      throw new Error(`${app.id}: each example needs a descriptive label`);
    }
    if (!/^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[a-f0-9]{40}\/.+/.test(example.url ?? '')) {
      throw new Error(`${app.id}: pin example URLs to a neurodeskorg/webapps dataset commit`);
    }
  }
  if (app.ci.browser_test !== true) throw new Error(`${app.id}: enable ci.browser_test for the example workflow`);
  return examples;
}
