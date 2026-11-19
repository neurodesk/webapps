#!/usr/bin/env node
// Bind a saved reference image (`docker save`, OCI image layout in a tar) to the image
// Docker runs. Several digests name one image, and they are not interchangeable:
//
// - the target digest, the one descriptor index.json lists: the image manifest itself,
//   or (BuildKit with attestations) an image index holding that manifest and attestation
//   manifests that refer to it;
// - the image manifest digest, which is the target digest when there is no index;
// - Docker's local image ID, which is the target digest in a containerd image store but
//   the config digest in a classic (graph driver) store.
//
// None is assumed equal to another. The archive is checked first: index.json names
// exactly one image, every blob hashes to its name, every descriptor's blob is present
// at its declared size, and each layer decompresses to the diff_id its config lists.
// Then `docker image inspect` output is accepted only if its ID is the target or the
// config digest and its RootFS layers are the config's diff_ids, in order.
//
// Usage:
//   node oci_identity.mjs ARCHIVE.tar
//     Check the archive; print its identity as JSON.
//   node oci_identity.mjs ARCHIVE.tar INSPECT.json OUTPUT.json
//     Also check `docker image inspect` output of the loaded image, write both
//     identities to OUTPUT.json (which must not exist), and print the local image ID
//     to pass to run_runtime_cli.py.
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const MANIFEST_TYPES = new Set([
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
]);
const INDEX_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
]);
const CONFIG_TYPES = new Set([
  'application/vnd.oci.image.config.v1+json',
  'application/vnd.docker.container.image.v1+json',
]);
// Docker restores layers of either family; the reviewed archive mixes them.
const LAYER_COMPRESSION = new Map([
  ['application/vnd.oci.image.layer.v1.tar', 'none'],
  ['application/vnd.oci.image.layer.v1.tar+gzip', 'gzip'],
  ['application/vnd.oci.image.layer.v1.tar+zstd', 'zstd'],
  ['application/vnd.docker.image.rootfs.diff.tar.gzip', 'gzip'],
]);
// Manifests, configs and index.json are small JSON; anything larger is not read whole.
const JSON_LIMIT = 4 * 1024 * 1024;

export class OciIdentityError extends Error {}

function fail(message) {
  throw new OciIdentityError(message);
}

function parseNumber(field, what) {
  if (field[0] & 0x80) {
    // GNU base-256: the remaining bits of the field, big-endian.
    let value = BigInt(field[0] & 0x7f);
    for (const byte of field.subarray(1)) value = (value << 8n) | BigInt(byte);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail(`tar ${what} is too large`);
    return Number(value);
  }
  const text = field.toString('latin1').replace(/[\0 ]+$/u, '').trim();
  if (!/^[0-7]*$/u.test(text)) fail(`tar ${what} is not octal: ${JSON.stringify(text)}`);
  return text === '' ? 0 : Number.parseInt(text, 8);
}

function parsePax(buffer) {
  const records = {};
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) fail('malformed pax header');
    const length = Number.parseInt(buffer.toString('latin1', offset, space), 10);
    if (!(length > 0) || offset + length > buffer.length) fail('malformed pax record length');
    const record = buffer.toString('utf8', space + 1, offset + length - 1);
    const equals = record.indexOf('=');
    if (equals < 0) fail('malformed pax record');
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

function normaliseName(name) {
  return name.replace(/^(\.\/)+/u, '').replace(/\/+$/u, '');
}

async function readRange(handle, position, length) {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead !== length) fail('truncated tar archive');
  return buffer;
}

/** Every entry of a tar archive, by name: its type, data offset and size. Data is not read. */
async function tarEntries(path) {
  const handle = await open(path, 'r');
  try {
    const { size: archiveBytes } = await handle.stat();
    const entries = new Map();
    let offset = 0;
    let pax = {};
    let longName = null;
    for (;;) {
      if (offset + 512 > archiveBytes) fail('truncated tar archive: no end-of-archive marker');
      const header = await readRange(handle, offset, 512);
      if (header.every((byte) => byte === 0)) break;
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 0x20 : header[i];
      if (sum !== parseNumber(header.subarray(148, 156), 'checksum')) fail(`tar header checksum mismatch at byte ${offset}`);
      const type = header[156] === 0 ? '0' : String.fromCharCode(header[156]);
      const size = pax.size === undefined ? parseNumber(header.subarray(124, 136), 'size') : Number(pax.size);
      const data = offset + 512;
      if (data + size > archiveBytes) fail('truncated tar archive');
      if (type === 'x') {
        pax = parsePax(await readRange(handle, data, size));
      } else if (type === 'L') {
        longName = (await readRange(handle, data, size)).toString('utf8').replace(/\0.*$/su, '');
      } else if (type !== 'g') {
        const prefix = header.toString('utf8', 345, 500).replace(/\0.*$/su, '');
        const short = header.toString('utf8', 0, 100).replace(/\0.*$/su, '');
        const name = normaliseName(pax.path ?? longName ?? (prefix ? `${prefix}/${short}` : short));
        if (entries.has(name)) fail(`duplicate tar entry ${name}`);
        entries.set(name, { type, offset: data, size });
        pax = {};
        longName = null;
      }
      offset = data + Math.ceil(size / 512) * 512;
    }
    return { entries, archiveBytes };
  } finally {
    await handle.close();
  }
}

/** SHA-256 of the whole file and of each [start, end) range, in one sequential read. */
async function hashRanges(path, ranges) {
  const ordered = [...ranges].sort((a, b) => a.start - b.start);
  const whole = createHash('sha256');
  let position = 0;
  let first = 0;
  for await (const chunk of createReadStream(path, { highWaterMark: 1 << 20 })) {
    whole.update(chunk);
    const end = position + chunk.length;
    while (first < ordered.length && ordered[first].end <= position) first++;
    for (let i = first; i < ordered.length && ordered[i].start < end; i++) {
      const from = Math.max(ordered[i].start, position);
      const to = Math.min(ordered[i].end, end);
      if (from < to) ordered[i].hash.update(chunk.subarray(from - position, to - position));
    }
    position = end;
  }
  return whole.digest('hex');
}

function decompressor(kind, mediaType) {
  if (kind === 'none') return null;
  if (kind === 'gzip') return zlib.createGunzip();
  if (kind === 'zstd' && typeof zlib.createZstdDecompress === 'function') return zlib.createZstdDecompress();
  return fail(`cannot check the diff_id of a ${mediaType} layer with this Node`);
}

async function uncompressedDigest(path, entry, mediaType) {
  const hash = createHash('sha256');
  const source = createReadStream(path, { start: entry.offset, end: entry.offset + entry.size - 1 });
  const inflate = decompressor(LAYER_COMPRESSION.get(mediaType), mediaType);
  const stream = inflate ? source.pipe(inflate) : source;
  if (inflate) source.on('error', (error) => inflate.destroy(error));
  if (entry.size > 0) {
    for await (const chunk of stream) hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

function requireDigest(value, what) {
  if (typeof value !== 'string' || !DIGEST.test(value)) fail(`${what} is not a sha256 digest: ${JSON.stringify(value)}`);
  return value;
}

function parseJson(buffer, what) {
  try {
    return JSON.parse(buffer.toString('utf8'));
  } catch {
    return fail(`${what} is not JSON`);
  }
}

/** Check an OCI image-layout tar and return the identity of the one image it holds. */
export async function readOciArchive(path) {
  const { entries, archiveBytes } = await tarEntries(path);
  const handle = await open(path, 'r');
  const readEntry = async (name, what) => {
    const entry = entries.get(name);
    if (!entry || entry.type !== '0') fail(`the archive has no ${what} (${name})`);
    if (entry.size > JSON_LIMIT) fail(`${what} is larger than ${JSON_LIMIT} bytes`);
    return parseJson(await readRange(handle, entry.offset, entry.size), what);
  };
  let identity;
  try {
    const layout = await readEntry('oci-layout', 'oci-layout file');
    if (typeof layout.imageLayoutVersion !== 'string') fail('oci-layout has no imageLayoutVersion');
    const blobs = new Map();
    for (const [name, entry] of entries) {
      const match = /^blobs\/sha256\/([^/]+)$/u.exec(name);
      if (!match) continue;
      if (!/^[0-9a-f]{64}$/u.test(match[1])) fail(`blob name is not a sha256 digest: ${name}`);
      if (entry.type !== '0') fail(`blob ${name} is not a regular file`);
      blobs.set(`sha256:${match[1]}`, entry);
    }
    const index = await readEntry('index.json', 'index.json');
    if (index.schemaVersion !== 2 || !Array.isArray(index.manifests)) fail('index.json is not an OCI image index');
    if (index.manifests.length !== 1) fail(`index.json lists ${index.manifests.length} manifests; save exactly one image`);
    const top = index.manifests[0];
    const blob = async (descriptor, what, json) => {
      const digest = requireDigest(descriptor?.digest, `${what} digest`);
      const entry = blobs.get(digest);
      if (!entry) fail(`the archive has no blob for the ${what} ${digest}`);
      if (descriptor.size !== entry.size) fail(`the ${what} ${digest} is ${entry.size} bytes, not the ${descriptor.size} its descriptor declares`);
      return json ? parseJson(await readRange(handle, entry.offset, entry.size), what) : entry;
    };
    const reachable = new Set();
    const readManifest = async (descriptor, what) => {
      if (!MANIFEST_TYPES.has(descriptor?.mediaType)) fail(`the ${what} has an unknown media type ${JSON.stringify(descriptor?.mediaType)}`);
      const manifest = await blob(descriptor, what, true);
      if (manifest.schemaVersion !== 2) fail(`the ${what} is not schema version 2`);
      if (manifest.mediaType !== undefined && manifest.mediaType !== descriptor.mediaType) fail(`the ${what}'s media type differs from its descriptor`);
      if (!Array.isArray(manifest.layers)) fail(`the ${what} lists no layers`);
      await blob(manifest.config, `${what} config`, false);
      for (const layer of manifest.layers) await blob(layer, `${what} layer`, false);
      for (const reached of [descriptor, manifest.config, ...manifest.layers]) reachable.add(reached.digest);
      return manifest;
    };
    const targetDigest = requireDigest(top.digest, 'index.json target digest');
    let imageDescriptor = top;
    const attestations = [];
    if (INDEX_TYPES.has(top.mediaType)) {
      const nested = await blob(top, 'image index', true);
      if (nested.schemaVersion !== 2 || !Array.isArray(nested.manifests)) fail('the image index is not schema version 2');
      const isAttestation = (descriptor) => descriptor.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest';
      const images = nested.manifests.filter((descriptor) => !isAttestation(descriptor));
      if (images.length !== 1) fail(`the image index holds ${images.length} image manifests; save a single-platform image`);
      imageDescriptor = images[0];
      for (const descriptor of nested.manifests.filter(isAttestation)) {
        if (descriptor.annotations['vnd.docker.reference.digest'] !== imageDescriptor.digest) fail(`attestation manifest ${descriptor.digest} refers to another image`);
        await readManifest(descriptor, 'attestation manifest');
        attestations.push(descriptor.digest);
      }
    } else if (!MANIFEST_TYPES.has(top.mediaType)) {
      fail(`index.json names an unknown media type ${JSON.stringify(top.mediaType)}`);
    }
    const manifestDigest = imageDescriptor.digest;
    const manifest = await readManifest(imageDescriptor, 'manifest');
    if (!CONFIG_TYPES.has(manifest.config?.mediaType)) fail(`unknown config media type ${JSON.stringify(manifest.config?.mediaType)}`);
    const configDigest = manifest.config.digest;
    const config = await blob(manifest.config, 'config', true);
    if (manifest.layers.length === 0) fail('the manifest lists no layers');
    for (const layer of manifest.layers) {
      if (!LAYER_COMPRESSION.has(layer.mediaType)) fail(`unknown layer media type ${JSON.stringify(layer.mediaType)}`);
    }
    if (config.rootfs?.type !== 'layers' || !Array.isArray(config.rootfs.diff_ids)) fail('the config has no layered rootfs');
    const diffIds = config.rootfs.diff_ids.map((id, i) => requireDigest(id, `diff_id ${i}`));
    if (diffIds.length !== manifest.layers.length) fail(`the manifest lists ${manifest.layers.length} layers but the config ${diffIds.length} diff_ids`);

    const ranges = [...blobs].map(([digest, entry]) => ({ digest, start: entry.offset, end: entry.offset + entry.size, hash: createHash('sha256') }));
    const archiveSha256 = await hashRanges(path, ranges);
    for (const { digest, hash } of ranges) {
      const actual = `sha256:${hash.digest('hex')}`;
      if (actual !== digest) fail(`blob ${digest} hashes to ${actual}`);
    }
    for (const [i, layer] of manifest.layers.entries()) {
      const actual = await uncompressedDigest(path, blobs.get(layer.digest), layer.mediaType);
      if (actual !== diffIds[i]) fail(`layer ${i} (${layer.digest}) decompresses to ${actual}, not the config's diff_id ${diffIds[i]}`);
    }
    // docker save also writes its legacy manifest.json; when present it must name the same image.
    if (entries.has('manifest.json')) {
      const legacy = await readEntry('manifest.json', 'manifest.json');
      const path = (digest) => `blobs/sha256/${digest.slice('sha256:'.length)}`;
      if (!Array.isArray(legacy) || legacy.length !== 1) fail('manifest.json does not describe exactly one image');
      if (legacy[0].Config !== path(configDigest)) fail('manifest.json names another config than the OCI manifest');
      if (!isDeepStrictEqual(legacy[0].Layers, manifest.layers.map((layer) => path(layer.digest)))) fail('manifest.json names other layers than the OCI manifest');
    }
    const referenced = new Set([targetDigest, ...reachable]);
    identity = {
      archive: { bytes: archiveBytes, sha256: archiveSha256 },
      targetDigest,
      targetMediaType: top.mediaType,
      manifestDigest,
      configDigest,
      attestations,
      diffIds,
      layers: manifest.layers.map(({ digest, size, mediaType }) => ({ digest, size, mediaType })),
      unreferencedBlobs: [...blobs.keys()].filter((digest) => !referenced.has(digest)).sort(),
    };
  } finally {
    await handle.close();
  }
  return identity;
}

/**
 * The local image ID to run, from `docker image inspect` output of the loaded image.
 * A containerd image store reports the target digest, a classic store the config digest.
 */
export function localImage(identity, inspected) {
  if (!Array.isArray(inspected) || inspected.length !== 1) fail('docker image inspect output must describe exactly one image');
  const [image] = inspected;
  const id = image?.Id;
  let store;
  if (id === identity.targetDigest) store = 'containerd (image ID is the target digest index.json names)';
  else if (id === identity.configDigest) store = 'classic (image ID is the config digest)';
  else fail(`Docker's image ID ${JSON.stringify(id)} is neither the archive's target digest ${identity.targetDigest} nor its config digest ${identity.configDigest}`);
  if (image.RootFS?.Type !== 'layers' || !isDeepStrictEqual(image.RootFS.Layers, identity.diffIds)) {
    fail("the loaded image's RootFS layers are not the archive config's diff_ids in order");
  }
  return { id, store, repoTags: image.RepoTags ?? [], repoDigests: image.RepoDigests ?? [] };
}

async function main(argv) {
  if (argv.length !== 1 && argv.length !== 3) {
    throw new Error('Usage: node oci_identity.mjs ARCHIVE.tar [INSPECT.json OUTPUT.json]');
  }
  const identity = await readOciArchive(argv[0]);
  if (argv.length === 1) {
    console.log(JSON.stringify(identity, null, 2));
    return;
  }
  const local = localImage(identity, JSON.parse(await readFile(argv[1], 'utf8')));
  await writeFile(argv[2], `${JSON.stringify({ ...identity, local }, null, 2)}\n`, { flag: 'wx' });
  console.log(local.id);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof OciIdentityError ? `oci_identity: ${error.message}` : error);
    process.exit(1);
  });
}
