import { readFile, writeFile } from 'node:fs/promises';
import { nextVersion } from '../lib/app-versions.mjs';

const path = 'packages/desktop/package.json';
const manifest = JSON.parse(await readFile(path, 'utf8'));
manifest.version = nextVersion(manifest.version, 'patch', process.env.DESKTOP_RELEASE_DATE);
await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(manifest.version);
