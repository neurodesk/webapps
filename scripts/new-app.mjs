#!/usr/bin/env node
// scripts/new-app.mjs
// Scaffold an app wired to the repository's shared shell and components into
// apps/<name>, then register it in registry/apps.yml (the deployment source of truth).
//
//   pnpm new-app <name> [--runtime <runtime>] [--shell <shell>] [--category <id>]
//                       [--title <title>] [--description <text>] [--keywords a,b,c]
//
// The template imports @neurodesk/webapp-components/* by package name (not
// ../../src), ships its own package.json/vite/eslint/wrangler config,
// a DOM-independent Node test, and a Playwright browser test. Missing template files
// abort loudly instead of being silently skipped.
//
// The registry entry is written through the yaml document model (comments and
// formatting survive) and validated with the real loader before anything is
// touched on disk, so a rejected entry leaves the repo untouched.
import { cp, mkdtemp, readFile, writeFile, access, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import {
  RUNTIMES,
  SHELLS,
  addAppToRegistryText,
  loadAppsRegistry,
} from './lib/apps-registry.mjs';
import { nextVersion, releaseDate } from './lib/app-versions.mjs';

const ID = /^[a-z][a-z0-9-]*$/;
const DEFAULTS = {
  runtime: 'react-vite',
  shell: 'imaging-workspace',
  category: 'data-preparation',
};

function usage() {
  return [
    'Usage: pnpm new-app <name> [options]   (lowercase kebab-case, e.g. cerebellum)',
    '',
    `  --runtime <runtime>      one of ${[...RUNTIMES].join(', ')} (default ${DEFAULTS.runtime})`,
    `  --shell <shell>          one of ${[...SHELLS].join(', ')} (default ${DEFAULTS.shell})`,
    `  --category <id>          a site category id from registry/apps.yml (default ${DEFAULTS.category})`,
    '  --title <title>          catalog title (default: <name>)',
    '  --description <text>     catalog description (default: TODO describe <name>.)',
    '  --keywords <a,b,c>       comma-separated search keywords (default: TODO)',
    '  --help                   show this message',
  ].join('\n');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

let args;
try {
  args = parseArgs({
    allowPositionals: true,
    options: {
      runtime: { type: 'string' },
      shell: { type: 'string' },
      category: { type: 'string' },
      title: { type: 'string' },
      description: { type: 'string' },
      keywords: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
} catch (error) {
  fail(`${error.message}\n\n${usage()}`);
}

if (args.values.help) {
  console.log(usage());
  process.exit(0);
}

const [name, ...extra] = args.positionals;
if (!name || !ID.test(name) || extra.length) fail(usage());

const runtime = args.values.runtime ?? DEFAULTS.runtime;
const shell = args.values.shell ?? DEFAULTS.shell;
const category = args.values.category ?? DEFAULTS.category;
const title = args.values.title?.trim() || name;
const description = args.values.description?.trim() || `TODO describe ${name}.`;
const keywords = (args.values.keywords ?? 'TODO')
  .split(',')
  .map((keyword) => keyword.trim())
  .filter(Boolean);

if (!RUNTIMES.has(runtime)) {
  fail(`Invalid --runtime '${runtime}'. Expected one of: ${[...RUNTIMES].join(', ')}`);
}
if (!SHELLS.has(shell)) {
  fail(`Invalid --shell '${shell}'. Expected one of: ${[...SHELLS].join(', ')}`);
}
if (!keywords.length) fail('--keywords must contain at least one keyword.');

const root = process.cwd();
const dest = join(root, 'apps', name);
const src = join(root, 'templates', 'app-template');
const registry = join(root, 'registry', 'apps.yml');

// Destination must be free.
try {
  await access(dest);
  fail(`apps/${name} already exists — pick another name.`);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

// Required template files must exist — fail loudly, do not silently skip.
const REQUIRED = [
  'package.json',
  'vite.config.js',
  'eslint.config.js',
  'playwright.config.js',
  'index.html',
  'src/main.js',
  'src/config.js',
  'examples.json',
  'test/config.test.js',
  'e2e/smoke.spec.js',
];
for (const f of REQUIRED) {
  try {
    await access(join(src, f));
  } catch {
    fail(`Template is missing required file: ${f} — aborting.`);
  }
}

// The current registry must already be valid, and --category must name one of
// its site categories, before we try to add anything to it.
let current;
try {
  current = await loadAppsRegistry(registry);
} catch (error) {
  fail(`registry/apps.yml is invalid before scaffolding; fix it first.\n${error.message}`);
}
const categoryIds = current.site.categories.map(({ id }) => id);
if (!categoryIds.includes(category)) {
  fail(`Invalid --category '${category}'. Expected one of: ${categoryIds.join(', ')}`);
}

// Build the registry entry. Local apps are always experimental: an active app
// needs a pinned 40-character commit source, which a fresh scaffold cannot have.
const toolchains = runtime.includes('rust') ? ['node', 'rust-wasm'] : ['node'];
const entry = {
  id: name,
  path: name,
  title,
  description,
  categories: [category],
  keywords,
  legacy_domain: null,
  runtime,
  model_manifest: null,
  asset_manifest_schema: null,
  source: 'neurodesk/webapps@local',
  license: 'NOASSERTION',
  maintainers: ['neurodesk'],
  support_status: 'experimental',
  shell,
  ci: {
    toolchains,
    shared_runtime: false,
    browser_test: true,
    release: false,
  },
};

// Serialize through the yaml document model and validate the candidate with
// the real loader on a scratch copy. The real registry is only written once
// the loader accepts the result, so a rejection cannot leave it modified.
const originalText = await readFile(registry, 'utf8');
const nextText = addAppToRegistryText(originalText, entry);
const scratch = await mkdtemp(join(tmpdir(), 'new-app-registry-'));
try {
  const candidate = join(scratch, 'apps.yml');
  await writeFile(candidate, nextText);
  try {
    await loadAppsRegistry(candidate);
  } catch (error) {
    fail(`Refusing to register ${name}: the resulting registry does not validate.\n${error.message}`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}

await cp(src, dest, { recursive: true });

// Stamp APP_NAME into every text file that contains it.
async function stamp(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      await stamp(p);
    } else {
      const text = await readFile(p, 'utf8');
      if (text.includes('APP_NAME')) await writeFile(p, text.replaceAll('APP_NAME', name));
    }
  }
}
await stamp(dest);
const manifestPath = join(dest, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
manifest.version = nextVersion(manifest.version, 'patch', releaseDate());
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const examples = JSON.parse(await readFile(join(dest, 'examples.json'), 'utf8'));

// Every generated app participates in desktop packaging and offline validation.
for (const [filename, value] of [
  ['standalone.json', { desktop: true, profile: 'interactive', assets: [], downloads: [], containers: [] }],
  ['offline-assets.sources.json', examples.flatMap(example => example.files.map(({ url }) => ({ url, kind: 'example' })))],
  ['offline-assets.lock.json', examples.flatMap(example => example.files.map(({ url }) => url))],
]) {
  const path = join(root, 'registry', filename);
  const catalog = JSON.parse(await readFile(path, 'utf8'));
  catalog.apps[name] = value;
  await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
}

// Register the app so deploy + statistics workflows pick it up.
await writeFile(registry, nextText);

// Seed its About/Cite data. The shared shell renders packages, builder and
// ecosystem statements from this entry; test/app-information.test.mjs fails
// until every implemented method has a citation here.
const informationPath = join(root, 'registry', 'app-information.yml');
try {
  const current = await readFile(informationPath, 'utf8');
  if (!new RegExp(`^  ${name}:`, 'm').test(current)) {
    await writeFile(informationPath, `${current.replace(/\n*$/, '\n')}
  ${name}:
    packages:
      - { name: NiiVue, url: https://github.com/niivue/niivue, role: image viewer }
    citations:
      - group: Visualization
        title: NiiVue
        reference: "NiiVue Contributors. NiiVue: a WebGL2 medical image viewer [Computer software]."
        url: https://github.com/niivue/niivue
`);
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

console.log(`Created apps/${name} and registered it in registry/apps.yml. Next:`);
console.log('  pnpm install');
console.log(`  pnpm --filter ${name} dev`);
console.log(`CI installs, builds, runs tests, and publishes it at /${name}/ in the composite site.`);
