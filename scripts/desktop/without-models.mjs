import { cp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBundle, verifyBundle } from '../../packages/desktop/src/bundle.js';

export async function withoutModels(source, destination) {
  if (resolve(source) === resolve(destination)) throw new Error('Use a separate destination for the package without models');
  await verifyBundle(source);
  const bundle = await loadBundle(source);
  bundle.modelsIncluded = false;
  const modelAssets = Object.entries(bundle.assets).filter(([, asset]) => asset.kind === 'model');
  const modelsByHash = new Map(modelAssets.map(([url, asset]) => [asset.sha256, url]));
  const removed = new Set(modelAssets.map(([, asset]) => asset.path));
  for (const [, asset] of modelAssets) asset.remote = true;
  for (const [path, file] of Object.entries(bundle.files)) {
    if (modelsByHash.has(file.sha256)) {
      file.remote = { url: modelsByHash.get(file.sha256), offset: 0 };
      removed.add(path);
    }
  }
  // MuscleMap's browser download is split into hosting-sized pieces. Derive
  // these bytes from the same pinned complete model, never from the live site.
  const muscle = modelAssets.find(([url]) => url.endsWith('/musclemap-wholebody-v1.4-fp32.onnx'));
  const parts = Object.keys(bundle.files).filter(path => /\/musclemap-wholebody-v1\.4-fp32\.part-\d+$/.test(path)).sort();
  if (parts.length) {
    if (!muscle) throw new Error('Split MuscleMap model has no pinned complete source');
    let offset = 0;
    for (const path of parts) {
      bundle.files[path].remote = { url: muscle[0], offset };
      offset += bundle.files[path].bytes;
      removed.add(path);
    }
    if (offset !== muscle[1].bytes) throw new Error('Split model size does not match its pinned source');
  }
  await rm(destination, { recursive: true, force: true });
  await cp(source, destination, { recursive: true, filter: path => !removed.has(path.slice(resolve(source).length + 1).replaceAll('\\', '/')) });
  await writeFile(join(destination, 'manifest.json'), `${JSON.stringify(bundle, null, 2)}\n`);
  await verifyBundle(destination);
  return { removedFiles: removed.size, models: modelAssets.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await withoutModels(resolve(process.argv[2] || 'packages/desktop/resources'), resolve(process.argv[3] || 'packages/desktop/resources-light')));
}
