import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { isUrlWithinServiceWorkerScope } from './runtime-support.mjs';
import { stageOperationParameters } from './operation-parameters-runtime.mjs';
import { writeCompositeRuntimeCacheManifests } from './runtime-cache.mjs';

const TEXT_EXTENSIONS = new Set(['.html', '.js', '.mjs']);

function posix(path) {
  return path.split(sep).join('/');
}

function moduleReference(fromFile, target) {
  const path = posix(relative(dirname(fromFile), target));
  return path.startsWith('.') ? path : `./${path}`;
}

// Vite emits `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=[...])))=>...`; return each deps array's span.
function viteMapDepsRanges(source) {
  return [...source.matchAll(/__vite__mapDeps=\(i,m=__vite__mapDeps,d=\(m\.f\|\|\(m\.f=(\[[^\]]*\])/g)]
    .map(match => [match.index + match[0].length - match[1].length, match.index + match[0].length]);
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

async function copyVerifiedFamily({ family, repoRoot, siteDist, registry }) {
  const targetDir = join(siteDist, '_runtime', family.target);
  await mkdir(targetDir, { recursive: true });
  for (const file of family.files) {
    let source;
    if (file.source_package === 'runtime-support') {
      source = join(repoRoot, 'packages', 'runtime-support', file.source);
    } else {
      const app = registry.apps.find((candidate) => candidate.id === file.source_app);
      if (!app) throw new Error(`Runtime asset ${family.id}/${file.name} has unknown source app ${file.source_app}`);
      source = join(siteDist, app.path, file.source);
    }
    const actual = await sha256(source);
    if (actual !== file.sha256) {
      throw new Error(`Runtime asset checksum mismatch for ${source}: expected ${file.sha256}, got ${actual}`);
    }
    await cp(source, join(targetDir, file.name));
  }
}

function hasScopedOrt(app) {
  return app?.app_scoped_runtime_families?.some(id => id === 'ort-web' || id.startsWith('ort-web-'));
}

async function rewriteFile(file, runtimeRoot, app, relativePath) {
  const ortDir = join(runtimeRoot, 'ort-web', '1.21.0');
  const niftiReader = join(runtimeRoot, 'nifti-reader', '0.8.0', 'index.js');
  const sharedSource = join(runtimeRoot, 'webapp-components', '0.1.2', 'src');
  let source = await readFile(file, 'utf8');
  const original = source;

  if (app && /(['"])(?:\.\.?\/)*wasm\/ort[^'"]+\1/.test(source)
      && !hasScopedOrt(app)) {
    throw new Error(`${app.id}: threaded ONNX Runtime requires app_scoped_runtime_families to include a pinned ort-web family; shared workers escape the COI service-worker scope`);
  }

  if (hasScopedOrt(app)) {
    source = source.replace(
      /(ort\.env\.wasm\.wasmPaths\s*=\s*)(['"])((?:\.\.?\/)*wasm\/)\2/g,
      (_match, assignment, _quote, path) => {
        const origin = 'https://composite.invalid/';
        const serviceWorkerUrl = new URL(`${app.path}/coi-serviceworker.js`, origin);
        const runtimeUrl = new URL(path, new URL(relativePath, origin));
        if (!isUrlWithinServiceWorkerScope(serviceWorkerUrl, runtimeUrl)) {
          throw new Error(`${app.id} runtime escapes its service-worker scope: ${runtimeUrl.pathname}`);
        }
        return `${assignment}new URL(${JSON.stringify(path)}, self.location.href).href`;
      },
    );
  } else {
    source = source.replace(
      /(ort\.env\.wasm\.wasmPaths\s*=\s*)(['"])(?:\.\.?\/)*wasm\/\2/g,
      (_match, assignment) => {
        const path = `${moduleReference(file, ortDir)}/`;
        return `${assignment}new URL(${JSON.stringify(path)}, self.location.href).href`;
      },
    );
    source = source.replace(/(['"])(?:\.\.?\/)*wasm\/(ort[^'"]+)\1/g, (_match, quote, name) =>
      `${quote}${moduleReference(file, join(ortDir, name))}${quote}`);
    source = source.replace(/(['"])(?:\.\.?\/)*wasm\/\1/g, (_match, quote) =>
      `${quote}${moduleReference(file, ortDir)}/${quote}`);
  }
  source = source.replace(/(['"])(?:\.\.?\/)*nifti-js\/index\.js\1/g, (_match, quote) =>
    `${quote}${moduleReference(file, niftiReader)}${quote}`);
  source = source.replace(
    /(?<=['"])(?:\.\.\/|\.\/)*vendor\/webapp-components\/src(?=\/|['"])/g,
    moduleReference(file, sharedSource),
  );

  if (source !== original) await writeFile(file, source);
}

async function removeAppCopies(siteDist, registry) {
  for (const app of registry.apps) {
    const appDist = join(siteDist, app.path);
    await rm(join(appDist, 'nifti-js'), { recursive: true, force: true });
    await rm(join(appDist, 'vendor', 'webapp-components'), { recursive: true, force: true });
    if (hasScopedOrt(app)) continue;
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

// Vite names a bundled asset `<name>-<8-character hash>.<ext>`; a static app ships
// the same bytes as `<name>.<ext>`. The checksum, not the name, proves identity.
function unhashedName(file) {
  return basename(file).replace(/-[\w-]{8}(?=\.[^.]+$)/, '');
}

// A content-matched family skips bytes it does not know, so an app that moves to another build would
// silently keep its own copy. A family that lists `consumers` must be shared by exactly those apps.
function assertDeclaredConsumers({ family, asset, sharing, registry }) {
  if (!family.consumers) return;
  const built = new Set(registry.apps.map(app => app.id));
  for (const id of family.consumers) {
    if (built.has(id) && !sharing.has(id)) {
      throw new Error(`${id}: declared consumer of runtime family ${family.id} ships no ${asset.name} with sha256 ${asset.sha256}; `
        + 'register the build it now uses in runtime-assets/manifest.json and move the app to that family');
    }
  }
  for (const id of sharing) {
    if (!family.consumers.includes(id)) {
      throw new Error(`${id}: shares ${asset.name} of runtime family ${family.id} but is not in its consumers; add it in runtime-assets/manifest.json`);
    }
  }
}

// Runtime binaries can move to the shared store independently of their worker
// modules. Worker families retain their app scope policy and cannot opt in.
async function deduplicateSources({ manifest, files, siteDist, registry }) {
  const families = manifest.families.filter(family => family.deduplicate);
  const claimed = new Set();
  for (const family of families) {
    for (const asset of family.files) {
      const targetPath = join(siteDist, '_runtime', family.target, asset.name);
      const sharing = new Set();
      for (const app of registry.apps) {
        // An app's vendored components are not its own copies: removeAppCopies replaces them with the shared store.
        const vendored = join(siteDist, app.path, 'vendor', 'webapp-components') + sep;
        const appFiles = files.filter(file => file.startsWith(join(siteDist, app.path) + sep) && !file.startsWith(vendored));
        const byContent = family.match_by === 'sha256';
        const copies = appFiles.filter(file => !claimed.has(file) && (byContent
          ? extname(file) === extname(asset.source)
          : unhashedName(file) === unhashedName(asset.source)));
        if (!copies.length) continue;
        if (app.app_scoped_runtime_families?.includes(family.id)) throw new Error(`Cannot deduplicate scoped runtime ${family.id}`);
        for (const sourcePath of copies) {
          const actual = await sha256(sourcePath);
          if (byContent && actual !== asset.sha256) continue;
          // Another pinned version of the same runtime claims this copy; any other bytes are drift.
          if (actual !== asset.sha256 && families.some(other => other.files.some(file => file.name === asset.name && file.sha256 === actual))) continue;
          if (actual !== asset.sha256) {
            throw new Error(`Runtime asset checksum mismatch for ${sourcePath}: expected ${asset.sha256}, got ${actual}`);
          }
          const escapedName = basename(sourcePath).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          // Match the declared filename as a whole path segment, keeping any query or fragment, so empty strings
          // in minified workers cannot consume its opening quote and `highlight-style.css` is not `style.css`.
          const assetReference = new RegExp(`(['"])((?:[^'"\\n]*/)?${escapedName})([?#][^'"\\n]*)?\\1`, 'g');
          const appRoot = join(siteDist, app.path);
          let references = 0;
          for (const file of appFiles.filter(file => !claimed.has(file) && TEXT_EXTENSIONS.has(extname(file)))) {
            const original = await readFile(file, 'utf8');
            const mapDeps = viteMapDepsRanges(original);
            const rewritten = original.replace(assetReference, (match, quote, reference, suffix = '', offset) => {
              const referencedPath = reference.startsWith('/')
                ? resolve(siteDist, `.${reference}`)
                : resolve(dirname(file), reference);
              if (referencedPath === sourcePath) {
                references++;
                return `${quote}${moduleReference(file, targetPath)}${suffix}${quote}`;
              }
              const inMapDeps = mapDeps.some(([start, end]) => offset > start && offset < end);
              // Vite's preload helper prefixes the app base to each `__vite__mapDeps` entry.
              if (inMapDeps && resolve(appRoot, reference) === sourcePath) {
                references++;
                return `${quote}${posix(relative(appRoot, targetPath))}${suffix}${quote}`;
              }
              // A hashed stylesheet name is unique, so an asset reference that resolves nowhere would break once the copy is removed.
              // `new URL(x, import.meta.url)` is a module asset; `new URL(x, "https://…")` is not.
              const moduleUrl = /new\s+URL\(\s*$/.test(original.slice(Math.max(0, offset - 32), offset))
                && /^\s*,\s*import\.meta\.url\b/.test(original.slice(offset + match.length, offset + match.length + 48));
              // A reference to another existing file of the same name (vendor/style.css beside a
              // shared assets/style.css) stays local; only a reference that resolves nowhere fails.
              const elsewhere = existsSync(referencedPath) || (inMapDeps && existsSync(resolve(appRoot, reference)));
              if (byContent && (inMapDeps || moduleUrl) && !elsewhere) {
                throw new Error(`Unresolved reference ${reference} to deduplicated ${sourcePath} in ${file}`);
              }
              return match;
            });
            if (rewritten !== original) await writeFile(file, rewritten);
          }
          if (!references) throw new Error(`No static references found for deduplicated runtime ${sourcePath}`);
          await rm(sourcePath);
          claimed.add(sourcePath);
          sharing.add(app.id);
        }
      }
      assertDeclaredConsumers({ family, asset, sharing, registry });
    }
  }
}

async function sharedStylesheets(siteDist, registry) {
  const groups = new Map();
  for (const app of registry.apps) {
    const assets = join(siteDist, app.path, 'assets');
    const names = await readdir(assets).catch(error => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    for (const name of names.filter(name => name.endsWith('.css'))) {
      const source = await readFile(join(assets, name), 'utf8');
      if (/@import|url\((?!["']?data:)/i.test(source)) continue;
      const hash = createHash('sha256').update(source).digest('hex');
      const group = groups.get(hash) ?? [];
      group.push({ app, name });
      groups.set(hash, group);
    }
  }
  return [...groups].filter(([, copies]) => copies.length > 1).map(([hash, copies]) => ({
    id: `stylesheet-${hash}`, target: `styles/${hash}`, deduplicate: true, match_by: 'sha256',
    files: [{ name: 'shared.css', source_app: copies[0].app.id, source: `assets/${copies[0].name}`, sha256: hash }],
  }));
}

export async function assembleRuntimeAssetStore({ repoRoot, siteDist, registry }) {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== 1) throw new Error('Unsupported runtime-assets manifest schema');
  const runtimeRoot = join(siteDist, '_runtime');
  await rm(runtimeRoot, { recursive: true, force: true });

  manifest.families.push(...await sharedStylesheets(siteDist, registry));
  for (const family of manifest.families) {
    await copyVerifiedFamily({ family, repoRoot, siteDist, registry });
  }

  const sharedSource = join(runtimeRoot, 'webapp-components', '0.1.2', 'src');
  await cp(join(repoRoot, 'packages', 'components', 'src'), sharedSource, { recursive: true });
  await stageOperationParameters({ repoRoot, componentsSrc: sharedSource });
  const nvMcp = manifest.families.find(family => family.id === 'nv-mcp');
  if (nvMcp) {
    // Import-map apps load these shared components; their nv-mcp module imports the client the bundled apps share.
    const module = join(sharedSource, 'automation', 'nv-mcp.js');
    const client = join(runtimeRoot, nvMcp.target, nvMcp.files[0].name);
    const source = await readFile(module, 'utf8');
    await writeFile(module, source.replace(/(['"])@niivue\/nv-mcp\/browser\1/, (_match, quote) => `${quote}${moduleReference(module, client)}${quote}`));
  }

  const files = await walk(siteDist);
  for (const file of files) {
    if (!file.startsWith(runtimeRoot) && TEXT_EXTENSIONS.has(extname(file))) {
      const relativePath = posix(relative(siteDist, file));
      const app = registry.apps.find((candidate) => (
        relativePath === candidate.path || relativePath.startsWith(`${candidate.path}/`)
      ));
      await rewriteFile(file, runtimeRoot, app, relativePath);
    }
  }
  await deduplicateSources({ manifest, files, siteDist, registry });
  await removeAppCopies(siteDist, registry);
  await writeCompositeRuntimeCacheManifests({ siteDist, registry });
}
