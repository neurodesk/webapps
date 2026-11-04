// Restore the registered, unchanged acute examples and their original terms to TMPDIR.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { createHash } from 'node:crypto';

if (!process.env.TMPDIR) throw new Error('Set TMPDIR to the storage volume.');
const output = join(process.env.TMPDIR, 'calmar-acute-examples');
const sources = JSON.parse(await readFile(new URL('../../../registry/offline-assets.sources.json', import.meta.url)));
const assets = sources.apps.calmar.filter(asset => asset.url.includes('/examples/calmar/acute/'));
if (!assets.length) throw new Error('The acute examples have not been registered.');
for (const asset of assets) {
  if (!/^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[a-f0-9]{40}\//.test(asset.url)) {
    throw new Error('Acute examples must use an immutable dataset commit.');
  }
  const response = await fetch(asset.url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`${response.status}: ${asset.url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.bytes || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) {
    throw new Error(`Mirrored asset checksum mismatch: ${asset.url}`);
  }
  const path = new URL(asset.url).pathname;
  const dataset = path.includes('/isles2022/') ? 'isles2022' : 'soop';
  const directory = join(output, dataset);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, basename(path)), bytes);
}
console.log(`Verified ${assets.length} acute-example assets in ${output}`);
