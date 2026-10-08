// Fails when a release in a computed catalog update no longer serves the archives it verified. The
// publish job runs it before each commit attempt. Uses no packages, so it runs beside the write token.
// Usage: GH_TOKEN=... node scripts/verify-catalog-update.mjs update.json
import { readFile } from 'node:fs/promises';
import { checkUpdateAssets } from './lib/standalone-import.mjs';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: verify-catalog-update.mjs update.json');
const repository = process.env.GITHUB_REPOSITORY || 'neurodesk/webapps';
const headers = { accept: 'application/vnd.github+json' };
if (process.env.GH_TOKEN) headers.authorization = `Bearer ${process.env.GH_TOKEN}`;

async function fetchRelease(tag) {
  const response = await fetch(`https://api.github.com/repos/${repository}/releases/tags/${tag}`, { headers });
  if (!response.ok) throw new Error(`${tag}: HTTP ${response.status}`);
  return response.json();
}

await checkUpdateAssets(JSON.parse(await readFile(file, 'utf8')), fetchRelease);
console.log('every archive in the update is still the released one');
