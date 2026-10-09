// Checks that each native archive's validation receipt records its SHA-256, as the Standalone catalog
// requires before it lists the archive. Fails before a release uploads a receipt the catalog would refuse.
// Usage: node scripts/check-native-receipts.mjs DIRECTORY...
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { releasePlatform } from './lib/portable-command.mjs';
import { checkReceipt } from './lib/standalone-import.mjs';

const directories = process.argv.slice(2);
if (!directories.length) throw new Error('Usage: check-native-receipts.mjs DIRECTORY...');
let checked = 0;
for (const directory of directories) {
  for (const name of (await readdir(directory)).sort()) {
    const platform = releasePlatform(null, name);
    if (!platform) continue;
    const digest = createHash('sha256').update(await readFile(join(directory, name))).digest('hex');
    const text = await readFile(join(directory, `${name}.validation.txt`), 'utf8');
    checkReceipt({ name, digest, platform, native: { startsWithAppRelease: false }, text });
    console.log(`${name}: receipt records ${digest}`);
    checked += 1;
  }
}
if (!checked) throw new Error(`No native archives in ${directories.join(', ')}`);
