import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const destination = resolve('web/vendor/musclemap/src');
await rm(destination, { recursive: true, force: true });
await cp('../../packages/musclemap/src', destination, { recursive: true, filter: source => !source.endsWith('/node.js') });
for (const name of await readdir(destination)) {
  if (!name.endsWith('.js')) continue;
  const path = resolve(destination, name);
  const source = (await readFile(path, 'utf8'))
    .replaceAll("'@neurodesk/webapp-components/file-io/nifti'", "'../../webapp-components/src/file-io/NiftiUtils.js'")
    .replaceAll("'@neurodesk/webapp-components/volume'", "'../../webapp-components/src/volume/index.js'");
  await writeFile(path, source);
}
