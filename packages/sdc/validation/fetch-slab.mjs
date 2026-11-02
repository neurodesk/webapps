// Fetches the ds005134 slab DWI series (the noddi example, apps/noddi/examples.json) that the
// native slab runs of sdc/reference/ read, checks each file's SHA-256, and prints SDC_SLAB=DIR.
//   node packages/sdc/validation/fetch-slab.mjs DIR
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: fetch-slab.mjs DIR');
const examples = JSON.parse(await readFile(new URL('../../../apps/noddi/examples.json', import.meta.url), 'utf8'));
const files = examples.flatMap((example) => example.files).filter((file) => file.name.startsWith('sub-01_dir-AP_desc-slab_dwi.'));
const image = files.find((file) => file.name.endsWith('.nii.gz'));
if (files.length < 3 || !image) throw new Error('apps/noddi/examples.json no longer lists the slab series.');
await mkdir(directory, { recursive: true });
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
for (const file of files) {
  const path = join(directory, file.name);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || sha256(bytes) !== file.sha256) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match apps/noddi/examples.json`);
    await writeFile(path, bytes);
  }
}
console.log(`SDC_SLAB=${directory}`);
