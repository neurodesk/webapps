// Write a computed catalog update into registry/standalone.json. Uses no packages, so the job that holds
// a write token never runs dependency code.
// Usage: node scripts/apply-catalog-update.mjs update.json
import { readFile, writeFile } from 'node:fs/promises';
import { applyCatalogUpdate } from './lib/standalone-import.mjs';

const [file] = process.argv.slice(2);
if (!file) throw new Error('Usage: apply-catalog-update.mjs update.json');
const path = new URL('../registry/standalone.json', import.meta.url);
const catalog = JSON.parse(await readFile(path, 'utf8'));
applyCatalogUpdate(catalog, JSON.parse(await readFile(file, 'utf8')));
await writeFile(path, `${JSON.stringify(catalog, null, 2)}\n`);
