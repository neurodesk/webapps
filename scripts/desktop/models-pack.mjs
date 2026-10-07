import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { fileHash, loadBundle } from '../../packages/desktop/src/bundle.js';
import { prepareReleaseFiles } from './release-files.mjs';

// Every release rebuilds the asset files, so their timestamps and ownership
// differ while the model bytes do not. The archive is written here rather than
// by the system tar, because only GNU tar can fix every header field. Sorted
// entries, constant headers and a constant gzip header make one model set
// produce one archive, which lets publishing reuse a pack it already uploaded.
const block = 512;
const largest = 0o77777777777;
const gzipUnix = 3;

function octal(value, width) {
  return `${value.toString(8).padStart(width - 1, '0')}\0`;
}

// A POSIX.1-1988 USTAR header for a regular file owned by root at the epoch.
function tarHeader(name, size) {
  if (!/^[\x21-\x7e]+$/.test(name) || name.includes('/') || name.includes('\\')) throw new Error(`Pack entry is not a flat file name: ${JSON.stringify(name)}`);
  if (Buffer.byteLength(name) > 100) throw new Error(`Pack entry name exceeds the 100 bytes of a USTAR header: ${name}`);
  if (!Number.isSafeInteger(size) || size < 0 || size > largest) throw new Error(`Pack entry size does not fit a USTAR header: ${name} (${size} bytes)`);
  const header = Buffer.alloc(block);
  header.write(name, 0, 'latin1');
  header.write(octal(0o644, 8), 100, 'latin1');
  header.write(octal(0, 8), 108, 'latin1');
  header.write(octal(0, 8), 116, 'latin1');
  header.write(octal(size, 12), 124, 'latin1');
  header.write(octal(0, 12), 136, 'latin1');
  header.fill(' ', 148, 156);
  header.write('0', 156, 'latin1');
  header.write('ustar\0', 257, 'latin1');
  header.write('00', 263, 'latin1');
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
  return header;
}

async function* tarBlocks(directory, names) {
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path);
    if (!info.isFile()) throw new Error(`Pack entry is not a regular file: ${path}`);
    yield tarHeader(name, info.size);
    let written = 0;
    for await (const chunk of createReadStream(path)) {
      written += chunk.length;
      yield chunk;
    }
    if (written !== info.size) throw new Error(`Pack entry changed while it was archived: ${path}`);
    if (written % block) yield Buffer.alloc(block - written % block);
  }
  yield Buffer.alloc(2 * block);
}

// Writes the named files of one directory as a gzipped tar that depends only on
// their names and bytes. File contents are streamed: a model can be hundreds of
// megabytes.
export async function writeTarGz(archive, directory, names) {
  const sorted = [...names].sort();
  if (new Set(sorted).size !== sorted.length) throw new Error('Pack entry names repeat');
  await pipeline(Readable.from(tarBlocks(directory, sorted)), createGzip(), createWriteStream(archive));
  // zlib leaves the gzip name and timestamp empty but stamps the operating
  // system it was built for, the one header byte that differs per platform.
  const file = await open(archive, 'r+');
  try {
    const head = Buffer.alloc(10);
    await file.read(head, 0, 10, 0);
    if (head.readUInt32BE(0) !== 0x1f8b0800 || head.readUInt32LE(4) !== 0) throw new Error(`Gzip header carries a name or timestamp: ${head.toString('hex')}`);
    await file.write(Buffer.from([gzipUnix]), 0, 1, 9);
  } finally {
    await file.close();
  }
}

// The four platform archives carry byte-identical models, so the models ship
// once as the content-addressed cache the resolver already reads.
export async function modelsPack(full, light, archive, destination, { version }) {
  const complete = await loadBundle(full);
  const bundle = await loadBundle(light);
  const names = new Set();
  for (const [url, asset] of Object.entries(bundle.assets)) {
    if (!asset.remote || asset.kind !== 'model') continue;
    const source = complete.assets[url];
    if (source?.sha256 !== asset.sha256 || source.bytes !== asset.bytes) throw new Error(`Model is absent from the complete bundle: ${url}`);
    if (source.path !== `assets/${source.sha256}`) throw new Error(`Model asset is not content addressed: ${source.path}`);
    const path = join(full, source.path);
    if ((await stat(path)).size !== source.bytes || await fileHash(path) !== source.sha256) throw new Error(`Model file does not match its pinned hash: ${source.path}`);
    names.add(source.sha256);
  }
  if (!names.size) throw new Error('The package without models declares no downloadable models');
  const models = [...names].sort();
  await mkdir(dirname(archive), { recursive: true });
  await writeTarGz(archive, join(full, 'assets'), models);
  return { models, release: await prepareReleaseFiles(archive, destination, { version, platform: 'any', kind: 'models' }) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(import.meta.dirname, '../..');
  const version = JSON.parse(await readFile(join(root, 'packages/desktop/package.json'))).version;
  const result = await modelsPack(
    resolve(process.argv[2] || join(root, 'packages/desktop/resources')),
    resolve(process.argv[3] || join(root, 'packages/desktop/resources-light')),
    join(root, `packages/desktop/release/webapps-${version}-models.tar.gz`),
    join(root, 'packages/desktop/release/github'),
    { version },
  );
  console.log(`Packed ${result.models.length} models`);
  console.log(result.release);
}
