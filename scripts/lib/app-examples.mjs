import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './apps-registry.mjs';

export function exampleAssets(examples) {
  return examples.flatMap(example => example.files);
}

export async function loadAppExamples(app, root = repoRoot) {
  let examples;
  try {
    examples = JSON.parse(await readFile(join(root, 'apps', app.id, 'examples.json'), 'utf8'));
  } catch (error) {
    throw new Error(`${app.id}: provide examples.json with a working, pinned example`, { cause: error });
  }
  if (!Array.isArray(examples) || (examples.length === 0 && app.id !== 'seedseg')) {
    throw new Error(`${app.id}: examples.json must contain at least one example`);
  }
  const ids = new Set();
  for (const example of examples) {
    if (!/^[a-z][a-z0-9-]*$/.test(example.id ?? '') || ids.has(example.id)) {
      throw new Error(`${app.id}: examples need unique lowercase ids`);
    }
    ids.add(example.id);
    for (const field of ['label', 'description', 'expectedResult']) {
      if (typeof example[field] !== 'string' || !example[field].trim() || /TODO|placeholder/i.test(example[field])) {
        throw new Error(`${app.id}: each example needs a descriptive ${field}`);
      }
    }
    if (example.generated !== undefined) {
      throw new Error(`${app.id}: export synthetic examples and host their files in the pinned dataset`);
    }
    if (!Array.isArray(example.files) || example.files.length === 0) {
      throw new Error(`${app.id}: each example needs its complete files bundle`);
    }
    const names = new Set();
    for (const file of example.files) {
      if (!/^[a-z][a-z0-9-]*$/.test(file.role ?? '')) {
        throw new Error(`${app.id}: example file roles must be lowercase ids`);
      }
      if (typeof file.name !== 'string' || !file.name || /[\\/]/.test(file.name) || names.has(file.name)) {
        throw new Error(`${app.id}: example file names must be unique basenames`);
      }
      names.add(file.name);
      if (!/^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[a-f0-9]{40}\/.+/.test(file.url ?? '')) {
        throw new Error(`${app.id}: pin example URLs to a neurodeskorg/webapps dataset commit`);
      }
      if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`${app.id}: example checksums must be SHA-256 hex digests`);
      }
    }
  }
  if (app.ci.browser_test !== true) throw new Error(`${app.id}: enable ci.browser_test for the example workflow`);
  return examples;
}
