import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(appRoot, '..', '..', 'runtime-assets', 'manifest.json'), 'utf8'));

function requestedRuntimeFiles(command) {
  return command
    .split(/\s+/)
    .filter((token) => !token.startsWith('-') && /^[a-z0-9-]+:[^/]/.test(token))
    .flatMap((spec) => {
      const separator = spec.indexOf(':');
      const group = spec.slice(0, separator);
      return spec.slice(separator + 1).split(',').filter(Boolean).map((name) => ({ group, name }));
    });
}

test('every script the page runs at startup comes from the app origin', async () => {
  const html = await readFile(join(appRoot, 'web', 'index.html'), 'utf8');
  const blocking = [...html.matchAll(/<script\b([^>]*)>/g)]
    .map(([, attributes]) => attributes)
    .filter((attributes) => !/\b(?:defer|async)\b/.test(attributes))
    .map((attributes) => attributes.match(/\bsrc=["']([^"']+)["']/)?.[1])
    .filter(Boolean);
  assert.ok(blocking.includes('wasm/niivue.umd.js'), 'the page must load the NiiVue build that prebuild fetches');
  assert.deepEqual(blocking.filter((src) => /^(?:[a-z]+:)?\/\//i.test(src)), [],
    'a failed CDN request leaves the app without the global it starts with');
});

// The commands a package script runs, with every `pnpm <script>` step replaced by that script's own.
function scriptCommands(name, seen = new Set()) {
  assert.ok(pkg.scripts[name], `package.json has no ${name} script`);
  assert.ok(!seen.has(name), `${name} calls itself`);
  return pkg.scripts[name].split('&&').map((part) => part.trim()).flatMap((part) => {
    const called = part.match(/^pnpm (?:run )?([\w:-]+)$/)?.[1];
    return called && pkg.scripts[called] ? scriptCommands(called, new Set([...seen, name])) : [part];
  });
}

test('everything that serves the page fetches the pinned NiiVue file', async () => {
  const pinned = manifest.families.find((group) => group.id === 'niivue-umd');
  assert.match(pinned.files.find((file) => file.name === 'niivue.umd.js').sha256, /^[0-9a-f]{64}$/);
  const setup = await readFile(join(appRoot, 'web', 'setup.sh'), 'utf8');
  const fetches = (name) => scriptCommands(name).filter((part) => part.includes('fetch-app-runtime.mjs')).join(' ');
  for (const [name, command] of [['predev', fetches('predev')], ['prebuild', fetches('prebuild')], ['web/setup.sh', setup]]) {
    const niivue = requestedRuntimeFiles(command).filter((file) => file.group === 'niivue-umd').map((file) => file.name);
    assert.deepEqual(niivue, ['niivue.umd.js'], `${name} must request niivue-umd:niivue.umd.js`);
  }
});
