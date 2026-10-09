// Write released native archives into registry/standalone.json by hand; CI does the same in
// .github/workflows/standalone-catalog.yml. Needs the release tags locally (git fetch --tags).
// Usage: node scripts/desktop/import-native-releases.mjs [app@VERSION ...]
// With no arguments, every command-line entry is refreshed from the release it already names.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeReleases, portableSpecs } from '../lib/native-releases.mjs';
import { catalogReleases, parseReleases } from '../lib/standalone-import.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const catalog = JSON.parse(await readFile(join(root, 'registry/standalone.json'), 'utf8'));
const releases = process.argv.length > 2 ? parseReleases(process.argv.slice(2)) : catalogReleases(catalog, nativeReleases(await portableSpecs()));
const directory = await mkdtemp(join(tmpdir(), 'catalog-update-'));
try {
  const update = join(directory, 'update.json');
  const names = releases.map(({ id, version }) => `${id}@${version}`);
  execFileSync(process.execPath, [join(root, 'scripts/catalog-update.mjs'), '--out', update, ...names], { stdio: 'inherit' });
  execFileSync(process.execPath, [join(root, 'scripts/apply-catalog-update.mjs'), update], { stdio: 'inherit' });
} finally {
  await rm(directory, { recursive: true, force: true });
}
