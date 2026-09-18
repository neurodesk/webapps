import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fileHash, loadBundle } from '../../packages/desktop/src/bundle.js';
import { prepareReleaseFiles } from './release-files.mjs';

// Every release rebuilds the asset files, so their timestamps and ownership
// differ while the model bytes do not. Fixing each header field and dropping the
// gzip name and timestamp makes one model set produce one archive, which lets
// publishing reuse a pack it already uploaded.
const deterministic = ['--sort=name', '--mtime=@0', '--owner=0', '--group=0', '--numeric-owner', '--use-compress-program', 'gzip -n'];

// The four platform archives carry byte-identical models, so the models ship
// once as the content-addressed cache the resolver already reads.
export async function modelsPack(full, light, archive, destination, { version }) {
  const complete = await loadBundle(full);
  const bundle = await loadBundle(light);
  const names = new Set();
  for (const [url, asset] of Object.entries(bundle.assets)) {
    if (!asset.remote || asset.kind !== 'model') continue;
    const source = complete.assets[url];
    if (source?.sha256 !== asset.sha256 || source.bytes !== asset.bytes) throw new Error(`Model is absent from the complete bundle: ${url}`);
    if (source.path !== `assets/${source.sha256}`) throw new Error(`Model asset is not content addressed: ${source.path}`);
    const path = join(full, source.path);
    if ((await stat(path)).size !== source.bytes || await fileHash(path) !== source.sha256) throw new Error(`Model file does not match its pinned hash: ${source.path}`);
    names.add(source.sha256);
  }
  if (!names.size) throw new Error('The package without models declares no downloadable models');
  const models = [...names].sort();
  await mkdir(dirname(archive), { recursive: true });
  execFileSync('tar', [...deterministic, '-cf', archive, '-C', join(full, 'assets'), ...models], { stdio: 'inherit' });
  return { models, release: await prepareReleaseFiles(archive, destination, { version, platform: 'any', kind: 'models' }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..');
  const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'))).version;
  const result = await modelsPack(
    resolve(process.argv[2] || join(root, 'packages/desktop/resources')),
    resolve(process.argv[3] || join(root, 'packages/desktop/resources-light')),
    join(root, `packages/desktop/release/webapps-${version}-models.tar.gz`),
    join(root, 'packages/desktop/release/github'),
    { version },
  );
  console.log(`Packed ${result.models.length} models`);
  console.log(result.release);
}
