#!/usr/bin/env node
// Rebuilds vendor/freebrowse from FreeBrowse's development branch, which is
// not published to npm. Run from anywhere:
//   node packages/runtime-support/scripts/vendor-freebrowse.mjs
// It clones the pinned commit into a fresh directory under $TMPDIR, builds
// the library with FreeBrowse's own `npm pack`, and unpacks the tarball here.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPOSITORY = 'https://github.com/pwighton/freebrowse.git';
const BRANCH = '20260929-niivue-mono-fixes-merged';
const COMMIT = 'eae80a127fdd99974c80952e890bf18aa6e9d5dd';
// The branch links @niivue/niivue to a local niivue-mono checkout. rc.17 is
// the registry release closest to it: rc.16 plus the drawing undo snapshot
// API (niivue/mono#230) that the wand's undo calls.
const NIIVUE = '1.0.0-rc.17';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const destination = join(packageRoot, 'vendor', 'freebrowse');

const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

const work = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'freebrowse-vendor-'));
const checkout = join(work, 'freebrowse');
run('git', ['clone', '--quiet', '--branch', BRANCH, REPOSITORY, checkout]);
run('git', ['checkout', '--quiet', COMMIT], checkout);
const frontend = join(checkout, 'frontend');
run('npm', ['pkg', 'set', `peerDependencies.@niivue/niivue=${NIIVUE}`], frontend);
run('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error', '--save-exact', `@niivue/niivue@${NIIVUE}`], frontend);
run('npm', ['run', 'build:lib'], frontend);
// FreeBrowse's declarations name the volume `visible` flag of niivue/mono#224,
// which no NiiVue release has yet. tsc still emits; any other error stops here.
const typeErrors = spawnSync('npx', ['tsc', '-p', 'tsconfig.lib.json'], { cwd: frontend, encoding: 'utf8' }).stdout.match(/error TS\d+.*/g) ?? [];
const expected = /^error TS2353: .*'visible' does not exist in type 'VolumeUpdate'/;
if (typeErrors.some((line) => !expected.test(line))) throw new Error(`Unexpected FreeBrowse type errors:\n${typeErrors.join('\n')}`);
run('npx', ['tsc-alias', '-p', 'tsconfig.lib.json'], frontend);
run('node', ['scripts/fix-declarations.mjs'], frontend);
run('npm', ['run', 'build:readme'], frontend);
const packed = await mkdtemp(join(work, 'packed-'));
run('npm', ['pack', '--ignore-scripts', '--loglevel=error', '--pack-destination', packed], frontend);
const [tarball] = await readdir(packed);

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
run('tar', ['-xzf', join(packed, tarball), '-C', destination, '--strip-components=1']);
// Source maps point into the build checkout and double the vendored size.
run('find', [destination, '-name', '*.map', '-delete']);
for (const file of await readdir(join(destination, 'dist-lib'))) {
  if (!file.endsWith('.js')) continue;
  const path = join(destination, 'dist-lib', file);
  const source = await readFile(path, 'utf8');
  await writeFile(path, source.replace(/\n\/\/# sourceMappingURL=\S+\s*$/, '\n'));
}
const manifestPath = join(destination, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
// NiiVue stays external in dist-lib, so it is the host's peer only.
delete manifest.dependencies['@niivue/niivue'];
manifest.peerDependencies['@niivue/niivue'] = NIIVUE;
manifest.devDependencies = undefined;
manifest.scripts = undefined;
manifest.freebrowseSource = { repository: REPOSITORY, branch: BRANCH, commit: COMMIT, niivue: NIIVUE };
manifest.files = ['dist-lib', 'README.md'];
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(destination, 'README.md'), `# Vendored FreeBrowse

FreeBrowse's development branch is not published to npm, so this directory holds
its library build. The shared viewer (\`src/freebrowse-viewer\`) imports it as
\`freebrowse: file:./vendor/freebrowse\`. Generated: do not edit by hand.

- Source: ${REPOSITORY}
- Branch: \`${BRANCH}\`
- Commit: \`${COMMIT}\`
- Built against \`@niivue/niivue@${NIIVUE}\`, the peer this package declares.

## Rebuild

\`\`\`sh
node packages/runtime-support/scripts/vendor-freebrowse.mjs
pnpm install
\`\`\`

The script clones the commit into a fresh directory under \`$TMPDIR\`. The branch links
\`@niivue/niivue\` to a local niivue-mono checkout, so the script installs
\`@niivue/niivue@${NIIVUE}\` in its place and runs \`npm run build:lib\`, the
declaration build and \`npm pack\`. It then unpacks the tarball here, drops source maps,
removes the NiiVue dependency (dist-lib keeps NiiVue external, so it is a peer only) and
the build scripts from \`package.json\`, and writes this README.

## Known gaps

FreeBrowse's eye button sets a volume's \`visible\` flag (niivue/mono#224), which no NiiVue
release supports yet. NiiVue stores the flag and keeps drawing the volume, so the shared viewer
(\`src/freebrowse-viewer/volume-visibility.js\`) hides it through its opacity instead. The declaration
build reports that one type error; the script stops on any other.
`);
await rm(work, { recursive: true, force: true });
console.log(`FreeBrowse ${COMMIT.slice(0, 10)} -> ${destination}`);
