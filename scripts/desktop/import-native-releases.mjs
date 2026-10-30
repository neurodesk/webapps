// Write released native archives into registry/standalone.json by hand; CI does the same in
// .github/workflows/standalone-catalog.yml. Needs the release tags locally (git fetch --tags).
// Usage: node scripts/desktop/import-native-releases.mjs [app@VERSION ...]
// With no arguments, every command-line entry is refreshed from the release it already names.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { externalCatalog, nativeReleases, portableSpecs } from '../lib/native-releases.mjs';
import { catalogReleases, parseReleases } from '../lib/standalone-import.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = JSON.parse(await readFile(join(root, 'registry/standalone.json'), 'utf8'));
const natives = nativeReleases(await portableSpecs());
const releases = process.argv.length > 2 ? parseReleases(process.argv.slice(2)) : catalogReleases(catalog, natives);
const directory = await mkdtemp(join(tmpdir(), 'catalog-update-'));
try {
  const update = join(directory, 'update.json');
  const names = releases.map(({ id, version }) => `${id}@${version}`);
  execFileSync(process.execPath, [join(root, 'scripts/catalog-update.mjs'), '--out', update, ...names], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'scripts/apply-catalog-update.mjs'), update], { stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
// External releases are written from their release.json pins, not fetched: the pins are the verified
// bytes. The desktop suite bundles no command-line archives, so nothing else downloads them.
const path = join(root, 'registry/standalone.json');
const updated = JSON.parse(await readFile(path, 'utf8'));
for (const [id, sources] of natives) {
  for (const { external, spec } of sources) {
    if (!external) continue;
    Object.assign(updated.apps[id], externalCatalog(spec));
    console.log(`${id}: ${spec.repository} ${spec.tag} from its release.json pins`);
  }
}
await writeFile(path, `${JSON.stringify(updated, null, 2)}\n`);
