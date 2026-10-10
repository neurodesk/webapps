import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const source = fileURLToPath(new URL('../../../packages/seedseg/', import.meta.url));
const destination = fileURLToPath(new URL('../web/vendor/seedseg/', import.meta.url));
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(join(source, 'src'), join(destination, 'src'), { recursive: true, filter: path => !path.endsWith('/node.js') });
await cp(join(source, 'model.manifest.json'), join(destination, 'model.manifest.json'));
for (const name of await readdir(join(destination, 'src'))) {
  const path = join(destination, 'src', name);
  let text = await readFile(path, 'utf8');
  text = text.replaceAll('@neurodesk/webapp-components/file-io/nifti', '../../../vendor/webapp-components/src/file-io/NiftiUtils.js')
    .replaceAll('@neurodesk/webapp-components/volume', '../../../vendor/webapp-components/src/volume/index.js');
  await writeFile(path, text);
}
