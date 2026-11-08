#!/usr/bin/env node
import { cp, mkdir, readFile, writeFile, stat, readdir, chmod } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function checkFrontend(directory) {
  const problems = [];
  const walk = async path => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const filename = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Symlink in frontend: ${filename}`);
      if (entry.isDirectory()) await walk(filename);
      else if (/\.(html|css|js)$/.test(filename)) {
        const text = await readFile(filename, 'utf8');
        const refs = [];
        if (filename.endsWith('.html')) {
          for (const match of text.matchAll(/<(?:script|link|img)\b[^>]*?\b(?:src|href)=["']([^"']+)["']/g)) refs.push(match[1]);
        }
        if (filename.endsWith('.css')) {
          for (const match of text.matchAll(/url\(["']?([^\s)'";]+)["']?\)/g)) refs.push(match[1]);
        }
        if (filename.endsWith('.js')) {
          for (const match of text.matchAll(/(?:from\s*|import\s*\(?\s*|new URL\(\s*)["']((?:\.\.?\/|\/)[^"']+)["']/g)) refs.push(match[1]);
        }
        for (const ref of refs) {
          if (/^(?:https?:|data:|blob:|#)/.test(ref)) continue;
          const path = resolve(ref.startsWith('/') ? directory : dirname(filename), ref.startsWith('/') ? `.${ref}` : ref.split(/[?#]/)[0]);
          if (relative(directory, path).startsWith('..')) throw new Error(`Asset escapes frontend: ${ref}`);
          try { await stat(path); } catch { problems.push(`${relative(directory, filename)} -> ${ref}`); }
        }
      }
    }
  };
  await walk(directory);
  if (problems.length) throw new Error(`Missing packaged frontend dependencies:\n${problems.join('\n')}`);
  const index = await readFile(join(directory, 'nesvor/index.html'), 'utf8');
  if (!index.includes('/nesvor/assets/')) throw new Error('Expected production /nesvor/ asset base');
  if (!index.includes('data-neurodesk-app-shell')) throw new Error('Production app is missing the shared shell');
  const cryoEm = await readFile(join(directory, 'cryo-em/index.html'), 'utf8').catch(() => null);
  if (cryoEm !== null && !cryoEm.includes('/cryo-em/assets/')) throw new Error('Expected production /cryo-em/ asset base');
}

// Copies one production app to www/<id>/: no analytics, no Standalone download of the
// archive it is in, and (for the cryo-em app) the marker that its page is served by the server.
async function addFrontend(directory, id, frontend, { servedByServer = false } = {}) {
  const target = join(directory, 'www', id);
  await cp(frontend, target, { recursive: true });
  const catalogPath = join(target, 'standalone.json');
  const catalog = JSON.parse(await readFile(catalogPath, 'utf8'));
  // The installed server cannot embed a checksum for its own containing archive.
  // NeSVoR drops the whole setup; cryo-em keeps its cluster steps without the download.
  if (id === 'nesvor') delete catalog.apps[id].computeServer;
  else delete catalog.apps[id].computeServer?.download;
  await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
  const indexPath = join(target, 'index.html');
  let index = (await readFile(indexPath, 'utf8')).replace(/\sdata-ga4-measurement-id="[^"]*"/g, '');
  if (servedByServer) {
    if (!index.includes('<head>')) throw new Error(`${id}: index.html has no <head>`);
    index = index.replace('<head>', '<head>\n    <meta name="neurodesk-compute" content="same-origin" />');
  }
  await writeFile(indexPath, index);
}

export async function packageComputeServer({ binary, frontend, cryoEmFrontend, out, version, repository = root }) {
  if (!/^\d+\.\d+\.\d{8}$/.test(version)) throw new Error('Expected MAJOR.MINOR.YYYYMMDD version');
  const name = `neurodesk-compute-${version}-linux-x64`;
  const directory = join(out, name);
  await mkdir(directory, { recursive: false });
  await cp(binary, join(directory, 'neurodesk-compute'));
  await chmod(join(directory, 'neurodesk-compute'), 0o755);
  for (const filename of ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md']) await cp(join(repository, 'exes/compute-server', filename), join(directory, filename));
  await addFrontend(directory, 'nesvor', frontend);
  if (cryoEmFrontend) {
    await addFrontend(directory, 'cryo-em', cryoEmFrontend, { servedByServer: true });
    await writeFile(join(directory, 'www/index.html'), '<!doctype html>\n<html lang="en"><meta charset="utf-8"><title>Neurodesk Compute</title><ul><li><a href="/cryo-em/">Cryo-EM (RELION on Slurm)</a></li><li><a href="/nesvor/">NeSVoR</a></li></ul></html>\n');
  } else {
    await writeFile(join(directory, 'www/index.html'), '<!doctype html>\n<html lang="en"><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=/nesvor/"><title>NeSVoR</title><a href="/nesvor/">Open NeSVoR</a></html>\n');
  }
  const registry = JSON.parse(await readFile(join(repository, 'registry/neurocontainers.json'), 'utf8'));
  const image = registry.containers.nesvor.image;
  if (!/^vnmd\/nesvor_0\.5\.0@sha256:[a-f0-9]{64}$/.test(image)) throw new Error('NeSVoR runtime is not digest pinned');
  await writeFile(join(directory, 'runtime.json'), `${JSON.stringify({ schemaVersion: 1, platform: 'linux-x64', image, included: ['server', 'frontend'], prerequisites: ['Linux x86-64', 'NVIDIA GPU and compatible driver', 'Docker with NVIDIA Container Toolkit'], scientificRuntimeBundled: false, firstRunRequiresImagePull: true }, null, 2)}\n`);
  await writeFile(join(directory, 'start.sh'), `#!/bin/sh\nset -eu\ncd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec ./neurodesk-compute serve --www "$PWD/www" "$@"\n`);
  await chmod(join(directory, 'start.sh'), 0o755);
  await writeFile(join(directory, 'INSTALL.md'), `# Linux NVIDIA backend\n\nThis archive contains the compute server and production NeSVoR frontend. Docker, NVIDIA drivers, the NVIDIA Container Toolkit and the scientific container are not bundled.\n\n1. Install Docker and the NVIDIA Container Toolkit using your site's supported procedure.\n2. Run \`./neurodesk-compute doctor\` and resolve the reported prerequisites.\n3. Run \`./neurodesk-compute pull --runner docker\` while connected to the network to fetch the pinned runtime below.\n4. Run \`./start.sh\` and open the printed HTTPS URL. Open \`/nesvor/\` and pair using the installation code.\n\nPinned image: \`${image}\`.\n\nThe frontend can be served without internet access. Scientific offline readiness also requires container model assets and example data to have been staged and verified by the operator. This archive does not establish offline reconstruction readiness or include patient/example volumes. A real CUDA reconstruction must be validated before clinical deployment.\n`);
  await checkFrontend(join(directory, 'www'));
  const archive = join(out, `${name}.tar.gz`);
  const result = spawnSync('tar', ['-czf', archive, '-C', out, name], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'tar failed');
  const bytes = await readFile(archive);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  await writeFile(`${archive}.sha256`, `${sha256}  ${name}.tar.gz\n`);
  const metadata = { schemaVersion: 1, version, platform: 'linux-x64', archive: `${name}.tar.gz`, bytes: bytes.length, sha256, image, frontendBundled: true, scientificRuntimeBundled: false };
  await writeFile(join(out, `${name}.json`), `${JSON.stringify(metadata, null, 2)}\n`);
  return metadata;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const option = name => process.argv[process.argv.indexOf(name) + 1];
  for (const name of ['--binary', '--frontend', '--out', '--version']) if (!process.argv.includes(name)) throw new Error(`Missing ${name}`);
  const out = resolve(option('--out'));
  await mkdir(out, { recursive: true });
  const cryoEmFrontend = process.argv.includes('--cryo-em-frontend') ? resolve(option('--cryo-em-frontend')) : undefined;
  console.log(JSON.stringify(await packageComputeServer({ binary: resolve(option('--binary')), frontend: resolve(option('--frontend')), cryoEmFrontend, out, version: option('--version') }), null, 2));
}
