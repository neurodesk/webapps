// The Runtime reference image's identity check (validation/matlab/oci_identity.mjs), on
// small OCI archives written here: no Docker, no network.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { OciIdentityError, localImage, readOciArchive } from '../validation/matlab/oci_identity.mjs';

const SCRIPT = fileURLToPath(new URL('../validation/matlab/oci_identity.mjs', import.meta.url));
const OCI_GZIP = 'application/vnd.oci.image.layer.v1.tar+gzip';
const DOCKER_GZIP = 'application/vnd.docker.image.rootfs.diff.tar.gzip';
const OCI_TAR = 'application/vnd.oci.image.layer.v1.tar';
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const blobPath = (value) => `blobs/sha256/${value.slice('sha256:'.length)}`;
const json = (value) => Buffer.from(JSON.stringify(value));

function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 100, 'utf8');
  block.write('0000644\0', 100);
  block.write('0000000\0', 108);
  block.write('0000000\0', 116);
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  block.write('00000000000\0', 136);
  block.fill(0x20, 148, 156);
  block.write(type, 156);
  block.write('ustar\0', 257);
  block.write('00', 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return block;
}

function tar(files) {
  const parts = [];
  for (const [name, data] of files) {
    parts.push(header(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

/**
 * An image as `docker save` writes it: three layers in both media-type families (as the
 * reviewed archive mixes them), its config, manifest, index.json, oci-layout and the
 * legacy manifest.json. With `indexed`, index.json names an image index holding the
 * manifest and an attestation manifest, as BuildKit saves from a containerd store.
 * `edit` may change any part before the archive is written.
 */
function image(edit = {}, { indexed = false } = {}) {
  const contents = [Buffer.from('layer zero\n'.repeat(300)), Buffer.from('layer one'), Buffer.from('plain layer')];
  const parts = {
    layers: [
      { mediaType: OCI_GZIP, bytes: gzipSync(contents[0]) },
      { mediaType: DOCKER_GZIP, bytes: gzipSync(contents[1]) },
      { mediaType: OCI_TAR, bytes: contents[2] },
    ],
    config: { architecture: 'amd64', os: 'linux', rootfs: { type: 'layers', diff_ids: contents.map(digest) } },
  };
  edit.before?.(parts);
  const configBytes = json(parts.config);
  parts.manifest = {
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest(configBytes), size: configBytes.length },
    layers: parts.layers.map(({ mediaType, bytes }) => ({ mediaType, digest: digest(bytes), size: bytes.length })),
  };
  edit.manifest?.(parts);
  const manifestBytes = json(parts.manifest);
  const manifestDescriptor = { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digest(manifestBytes), size: manifestBytes.length };
  const extra = [];
  let target = manifestDescriptor;
  if (indexed) {
    const statement = Buffer.from('{"_type":"https://in-toto.io/Statement/v0.1"}');
    const attestationConfig = json({ architecture: 'unknown', os: 'unknown', rootfs: { type: 'layers', diff_ids: [digest(statement)] } });
    const attestation = json({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: digest(attestationConfig), size: attestationConfig.length },
      layers: [{ mediaType: 'application/vnd.in-toto+json', digest: digest(statement), size: statement.length }],
    });
    parts.imageIndex = {
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [
        { ...manifestDescriptor, platform: { architecture: 'amd64', os: 'linux' } },
        { mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: digest(attestation), size: attestation.length,
          annotations: { 'vnd.docker.reference.digest': manifestDescriptor.digest, 'vnd.docker.reference.type': 'attestation-manifest' },
          platform: { architecture: 'unknown', os: 'unknown' } },
      ],
    };
    edit.imageIndex?.(parts);
    const indexBytes = json(parts.imageIndex);
    target = { mediaType: 'application/vnd.oci.image.index.v1+json', digest: digest(indexBytes), size: indexBytes.length };
    extra.push(indexBytes, attestation, attestationConfig, statement);
  }
  parts.index = { schemaVersion: 2, manifests: [target] };
  parts.legacy = [{ Config: blobPath(digest(configBytes)), RepoTags: ['samsrf-reference:41ed1e96-r2023b'], Layers: parts.manifest.layers.map((layer) => blobPath(layer.digest)) }];
  edit.index?.(parts);
  parts.files = new Map([
    ['oci-layout', json({ imageLayoutVersion: '1.0.0' })],
    ['index.json', json(parts.index)],
    ['manifest.json', json(parts.legacy)],
    [blobPath(digest(manifestBytes)), manifestBytes],
    [blobPath(digest(configBytes)), configBytes],
    ...parts.layers.map(({ bytes }) => [blobPath(digest(bytes)), bytes]),
    ...extra.map((bytes) => [blobPath(digest(bytes)), bytes]),
  ]);
  edit.files?.(parts);
  return {
    archive: tar(parts.files),
    targetDigest: target.digest,
    manifestDigest: digest(manifestBytes),
    configDigest: digest(configBytes),
    diffIds: parts.config.rootfs.diff_ids,
  };
}

function scratch(t) {
  const directory = mkdtempSync(join(tmpdir(), 'samsrf-oci-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function write(t, built) {
  const path = join(scratch(t), 'image.oci.tar');
  writeFileSync(path, built.archive);
  return path;
}

const inspect = (id, layers) => [{ Id: id, RepoTags: ['samsrf-reference:41ed1e96-r2023b'], RepoDigests: [], RootFS: { Type: 'layers', Layers: layers } }];

test('the archive yields its manifest digest, config digest and diff_ids', async (t) => {
  const built = image();
  const identity = await readOciArchive(write(t, built));
  assert.equal(identity.targetDigest, built.manifestDigest);
  assert.equal(identity.manifestDigest, built.manifestDigest);
  assert.equal(identity.configDigest, built.configDigest);
  assert.notEqual(identity.manifestDigest, identity.configDigest);
  assert.deepEqual(identity.attestations, []);
  assert.deepEqual(identity.diffIds, built.diffIds);
  assert.deepEqual(identity.layers.map((layer) => layer.mediaType), [OCI_GZIP, DOCKER_GZIP, OCI_TAR]);
  assert.deepEqual(identity.archive, { bytes: built.archive.length, sha256: digest(built.archive).slice('sha256:'.length) });
  assert.deepEqual(identity.unreferencedBlobs, []);
});

test('a classic store reports the config digest as the image ID, and that is accepted', async (t) => {
  // The defect: the first verifier required the image ID to equal the manifest digest,
  // which rejects a valid restore into a classic Docker store.
  const built = image();
  const identity = await readOciArchive(write(t, built));
  const local = localImage(identity, inspect(built.configDigest, built.diffIds));
  assert.equal(local.id, built.configDigest);
  assert.match(local.store, /^classic/);
});

test('a containerd store reports the manifest digest as the image ID, and that is accepted', async (t) => {
  const built = image();
  const identity = await readOciArchive(write(t, built));
  const local = localImage(identity, inspect(built.manifestDigest, built.diffIds));
  assert.equal(local.id, built.manifestDigest);
  assert.match(local.store, /^containerd/);
});

test('an image ID that is neither digest, or other layers, is refused', async (t) => {
  const built = image();
  const identity = await readOciArchive(write(t, built));
  const other = digest(Buffer.from('another image'));
  assert.throws(() => localImage(identity, inspect(other, built.diffIds)), /neither the archive's target digest .* nor its config digest/);
  assert.throws(() => localImage(identity, inspect(built.configDigest, [...built.diffIds].reverse())), /RootFS layers/);
  assert.throws(() => localImage(identity, inspect(built.configDigest, built.diffIds.slice(1))), /RootFS layers/);
  assert.throws(() => localImage(identity, [...inspect(built.configDigest, built.diffIds), ...inspect(built.manifestDigest, built.diffIds)]), /exactly one image/);
  assert.throws(() => localImage(identity, [{ Id: built.configDigest, RootFS: { Type: 'other', Layers: built.diffIds } }]), /RootFS layers/);
});

const damaged = [
  ['a blob whose bytes do not hash to its name', { files: (p) => {
    const name = blobPath(p.manifest.layers[1].digest);
    const bytes = Buffer.from(p.files.get(name));
    bytes[bytes.length - 1] ^= 1;
    p.files.set(name, bytes);
  } }, /hashes to/],
  ['a layer that does not decompress to its diff_id', { before: (p) => { p.config.rootfs.diff_ids[0] = digest(Buffer.from('not this layer')); } }, /decompresses to .* not the config's diff_id/],
  ['a manifest with more layers than diff_ids', { before: (p) => { p.config.rootfs.diff_ids.pop(); } }, /3 layers but the config 2 diff_ids/],
  ['a missing layer blob', { files: (p) => { p.files.delete(blobPath(p.manifest.layers[2].digest)); } }, /no blob for the manifest layer/],
  ['a missing config blob', { files: (p) => { p.files.delete(blobPath(p.manifest.config.digest)); } }, /no blob for the manifest config/],
  ['a descriptor size that is not the blob size', { manifest: (p) => { p.manifest.layers[0].size += 1; } }, /not the \d+ its descriptor declares/],
  ['two images in index.json', { index: (p) => { p.index.manifests.push({ ...p.index.manifests[0] }); } }, /lists 2 manifests/],
  ['index.json calling a manifest an image index', { index: (p) => { p.index.manifests[0].mediaType = 'application/vnd.oci.image.index.v1+json'; } }, /image index is not schema version 2/],
  ['no index.json', { files: (p) => { p.files.delete('index.json'); } }, /no index\.json/],
  ['no oci-layout', { files: (p) => { p.files.delete('oci-layout'); } }, /no oci-layout file/],
  ['a legacy manifest.json naming another config', { index: (p) => { p.legacy[0].Config = blobPath(digest(Buffer.from('x'))); } }, /manifest\.json names another config/],
  ['a legacy manifest.json naming layers in another order', { index: (p) => { p.legacy[0].Layers.reverse(); } }, /manifest\.json names other layers/],
  ['an unknown layer media type', { before: (p) => { p.layers[2].mediaType = 'application/x-unknown'; } }, /unknown layer media type/],
];

for (const [name, edit, message] of damaged) {
  test(`the archive is refused: ${name}`, async (t) => {
    await assert.rejects(readOciArchive(write(t, image(edit))), (error) => error instanceof OciIdentityError && message.test(error.message));
  });
}

test('an image index around one manifest: containerd reports the index digest, classic the config digest', async (t) => {
  // BuildKit's docker save from a containerd store, as checked against a real archive.
  const built = image({}, { indexed: true });
  const identity = await readOciArchive(write(t, built));
  assert.equal(identity.targetDigest, built.targetDigest);
  assert.equal(identity.manifestDigest, built.manifestDigest);
  assert.notEqual(identity.targetDigest, identity.manifestDigest);
  assert.equal(identity.attestations.length, 1);
  assert.deepEqual(identity.unreferencedBlobs, []);
  assert.match(localImage(identity, inspect(built.targetDigest, built.diffIds)).store, /^containerd/);
  assert.match(localImage(identity, inspect(built.configDigest, built.diffIds)).store, /^classic/);
  // Neither store reports the inner manifest's digest when an index wraps it.
  assert.throws(() => localImage(identity, inspect(built.manifestDigest, built.diffIds)), /neither the archive's target digest/);
});

const damagedIndexes = [
  ['two platform manifests', (p) => { p.imageIndex.manifests.push({ ...p.imageIndex.manifests[0], platform: { architecture: 'arm64', os: 'linux' } }); }, /holds 2 image manifests/],
  ['an attestation for another image', (p) => { p.imageIndex.manifests[1].annotations['vnd.docker.reference.digest'] = digest(Buffer.from('x')); }, /refers to another image/],
];

for (const [name, edit, message] of damagedIndexes) {
  test(`the indexed archive is refused: ${name}`, async (t) => {
    await assert.rejects(readOciArchive(write(t, image({ imageIndex: edit }, { indexed: true }))), message);
  });
}

test('a config larger than the metadata limit is refused before it is read', async (t) => {
  const built = image({ before: (parts) => { parts.config.padding = 'x'.repeat(5 * 1024 * 1024); } });
  await assert.rejects(readOciArchive(write(t, built)), /config is larger than \d+ bytes/u);
});

test('a truncated archive is refused', async (t) => {
  const built = image();
  const path = join(scratch(t), 'truncated.tar');
  writeFileSync(path, built.archive.subarray(0, built.archive.length - 2048));
  await assert.rejects(readOciArchive(path), /truncated tar archive/);
});

test('the command line writes both identities once and prints the image ID to run', (t) => {
  const built = image();
  const directory = scratch(t);
  const archive = join(directory, 'image.oci.tar');
  writeFileSync(archive, built.archive);
  const inspected = join(directory, 'inspect.json');
  writeFileSync(inspected, JSON.stringify(inspect(built.configDigest, built.diffIds)));
  const output = join(directory, 'oci-identity.json');
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
  const bound = run(archive, inspected, output);
  assert.equal(bound.status, 0, bound.stderr);
  assert.equal(bound.stdout.trim(), built.configDigest);
  const written = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(written.manifestDigest, built.manifestDigest);
  assert.equal(written.local.id, built.configDigest);
  const again = run(archive, inspected, output);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /EEXIST/);
  writeFileSync(inspected, JSON.stringify(inspect(digest(Buffer.from('other')), built.diffIds)));
  const refused = run(archive, inspected, join(directory, 'refused.json'));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^oci_identity: Docker's image ID/m);
  const alone = run(archive);
  assert.equal(alone.status, 0, alone.stderr);
  assert.equal(JSON.parse(alone.stdout).configDigest, built.configDigest);
});
