import { build } from 'esbuild';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';

const { values } = parseArgs({ options: {
  metafile: { type: 'string' },
  outdir: { type: 'string' },
} });
const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(join(root, 'package.json'));
// The Node driver loads MindGrab's modules from disk, so the wrapper stays external; its package.json is
// inlined from SYNcro's pin because esbuild drops the JSON import attribute on external imports.
const mindgrab = { name: 'mindgrab', setup(build) {
  build.onResolve({ filter: /^@brainchop\/mindgrab$/ }, (args) => ({ path: args.path, external: true }));
  build.onResolve({ filter: /^@brainchop\/mindgrab\/package\.json$/ }, () => ({ path: require.resolve('@brainchop/mindgrab/package.json') }));
} };
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
    external: ['onnxruntime-node', 'nifti-reader-js', '@neurodesk/node-drivers'],
    plugins: [mindgrab],
    metafile: Boolean(values.metafile),
  });
  if (values.metafile) await writeFile(`${values.metafile}-${name}.json`, JSON.stringify(result.metafile));
}
await cp(new URL('../../registration/wasm', import.meta.url), join(outdir, 'registration'), { recursive: true });
await cp(new URL('../../greedy/wasm-single', import.meta.url), join(outdir, 'greedy'), { recursive: true });
