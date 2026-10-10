import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  metafile: { type: 'string' },
  outdir: { type: 'string' },
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const outdir = values.outdir ? resolve(values.outdir) : join(root, 'dist');
await mkdir(outdir, { recursive: true });
for (const name of ['index', 'node']) {
  const result = await build({
    entryPoints: [root + `src/${name}.js`],
    outfile: join(outdir, `${name}.js`),
    bundle: true,
    format: 'esm',
    platform: name === 'node' ? 'node' : 'browser',
    target: 'es2022',
    external: ['onnxruntime-node', 'nifti-reader-js'],
    metafile: Boolean(values.metafile),
  });
  if (values.metafile) await writeFile(`${values.metafile}-${name}.json`, JSON.stringify(result.metafile));
}
await cp(new URL('../../registration/wasm', import.meta.url), join(outdir, 'registration'), { recursive: true });
