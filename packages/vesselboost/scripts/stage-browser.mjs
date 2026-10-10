import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../../../', import.meta.url);
const destination = new URL('apps/vesselboost/web/vendor/vesselboost/', root);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(new URL('../src/', import.meta.url), new URL('src/', destination), {
  recursive: true,
  filter: (path) => !path.endsWith('/node.js'),
});
for (const name of ['pipeline.js', 'browser-loader.js']) {
  const path = new URL(`src/${name}`, destination);
  const source = await readFile(path, 'utf8');
  await writeFile(
    path,
    source
      .replaceAll(
        '@neurodesk/webapp-components/worker',
        '../../../vendor/webapp-components/src/worker/index.js'
      )
      .replaceAll(
        '@neurodesk/webapp-components/file-io/nifti',
        '../../../vendor/webapp-components/src/file-io/NiftiUtils.js'
      )
      .replaceAll(
        '@neurodesk/webapp-components/volume',
        '../../../vendor/webapp-components/src/volume/index.js'
      )
  );
}
await cp(
  new URL('../model.manifest.json', import.meta.url),
  new URL('model.manifest.json', destination)
);
await cp(
  new URL('../preprocessing/', import.meta.url),
  new URL('apps/vesselboost/web/preprocessing-wasm/', root),
  { recursive: true }
);
console.log(`Staged shared VesselBoost pipeline: ${fileURLToPath(destination)}`);
