import { join } from 'node:path';
import { build } from 'esbuild';

export async function stageOperationParameters({ repoRoot, componentsSrc }) {
  await build({
    entryPoints: [join(repoRoot, 'packages', 'components', 'src', 'automation', 'parameters.js')],
    outfile: join(componentsSrc, 'automation', 'parameters.js'),
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'es2022',
    legalComments: 'eof',
  });
}
