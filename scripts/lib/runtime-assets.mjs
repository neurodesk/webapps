import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative, sep } from 'node:path';

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs']);

function posix(path) {
  return path.split(sep).join('/');
}

function moduleReference(fromFile, target) {
  const path = posix(relative(dirname(fromFile), target));
  return path.startsWith('.') ? path : `./${path}`;
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function walk(directory, files = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path, files);
    else files.push(path);
  }
  return files;
}

async function copyVerifiedFamily({ family, siteDist, registry }) {
  const targetDir = join(siteDist, '_runtime', family.target);
  await mkdir(targetDir, { recursive: true });
  for (const file of family.files) {
    const app = registry.apps.find((candidate) => candidate.id === file.source_app);
    if (!app) throw new Error(`Runtime asset ${family.id}/${file.name} has unknown source app ${file.source_app}`);
    const source = join(siteDist, app.path, file.source);
    const actual = await sha256(source);
    if (actual !== file.sha256) {
      throw new Error(`Runtime asset checksum mismatch for ${source}: expected ${file.sha256}, got ${actual}`);
    }
    await cp(source, join(targetDir, file.name));
  }
}

async function rewriteFile(file, runtimeRoot) {
  const ortDir = join(runtimeRoot, 'ort-web', '1.21.0');
  const dcm2niix = join(runtimeRoot, 'dcm2niix', '1', 'index.js');
  const niftiReader = join(runtimeRoot, 'nifti-reader', '0.8.0', 'index.js');
  const sharedSource = join(runtimeRoot, 'webapp-components', '0.1.2', 'src');
  let source = await readFile(file, 'utf8');
  const original = source;

  source = source.replace(/(['"])(?:\.\.?\/)*wasm\/(ort[^'"]+)\1/g, (_match, quote, name) =>
    `${quote}${moduleReference(file, join(ortDir, name))}${quote}`);
  source = source.replace(/(['"])(?:\.\.?\/)*wasm\/\1/g, (_match, quote) =>
    `${quote}${moduleReference(file, ortDir)}/${quote}`);
  source = source.replace(/(['"])(?:\.\.?\/)*dcm2niix\/index\.js\1/g, (_match, quote) =>
    `${quote}${moduleReference(file, dcm2niix)}${quote}`);
  source = source.replace(/(['"])(?:\.\.?\/)*nifti-js\/index\.js\1/g, (_match, quote) =>
    `${quote}${moduleReference(file, niftiReader)}${quote}`);
  source = source.replaceAll('./vendor/webapp-components/src', moduleReference(file, sharedSource));

  if (source !== original) await writeFile(file, source);
}

async function removeAppCopies(siteDist, registry) {
  for (const app of registry.apps) {
    const appDist = join(siteDist, app.path);
    await rm(join(appDist, 'dcm2niix'), { recursive: true, force: true });
    await rm(join(appDist, 'nifti-js'), { recursive: true, force: true });
    await rm(join(appDist, 'vendor', 'webapp-components'), { recursive: true, force: true });
    const wasmDir = join(appDist, 'wasm');
    try {
      for (const entry of await readdir(wasmDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.startsWith('ort')) await rm(join(wasmDir, entry.name));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

export async function assembleRuntimeAssetStore({ repoRoot, siteDist, registry }) {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== 1) throw new Error('Unsupported runtime-assets manifest schema');
  const runtimeRoot = join(siteDist, '_runtime');
  await rm(runtimeRoot, { recursive: true, force: true });

  for (const family of manifest.families) {
    await copyVerifiedFamily({ family, siteDist, registry });
  }

  await cp(
    join(repoRoot, 'packages', 'components', 'src'),
    join(runtimeRoot, 'webapp-components', '0.1.2', 'src'),
    { recursive: true },
  );

  const files = await walk(siteDist);
  for (const file of files) {
    if (!file.startsWith(runtimeRoot) && TEXT_EXTENSIONS.has(extname(file))) {
      await rewriteFile(file, runtimeRoot);
    }
  }
  await removeAppCopies(siteDist, registry);
}
