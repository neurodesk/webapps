import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const outDir = resolve(root, process.env.SHOWCASE_OUT_DIR || 'dist/showcase');
const buildEnv = process.env.SHOWCASE_BUILD_ENV || 'local';
const versionSuffix = process.env.SHOWCASE_VERSION_SUFFIX || '';

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const file of ['index.html', 'README.md', 'LICENSE', 'package.json']) {
  await cp(join(root, file), join(outDir, file));
}

for (const dir of ['src', 'web', 'docs', 'templates']) {
  await cp(join(root, dir), join(outDir, dir), { recursive: true });
}

const sha = safeGit(['rev-parse', '--short', 'HEAD']) || 'unknown';
const branch = safeGit(['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown';
await writeFile(join(outDir, 'build-info.json'), `${JSON.stringify({
  sha,
  branch,
  dirty: Boolean(safeGit(['status', '--short'])),
  buildEnv,
  versionSuffix
}, null, 2)}\n`);

console.log(`Built showcase artifact at ${outDir}`);

function safeGit(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}
