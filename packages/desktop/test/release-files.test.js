import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareReleaseFiles } from '../../../scripts/desktop/release-files.mjs';

test('release parts reassemble byte for byte with independently verifiable checksums', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-parts-'));
  try {
    const input = Buffer.from('A complete offline archive with models and executable bytes.');
    const archive = join(root, 'webapps.zip');
    await writeFile(archive, input);
    const result = await prepareReleaseFiles(archive, join(root, 'out'), { version: '0.1.20260915', platform: 'macos-arm64', partBytes: 13 });
    const pieces = [];
    for (const part of result.parts) {
      const bytes = await readFile(join(root, 'out', part.filename));
      assert.equal(bytes.length, part.bytes);
      assert.ok(bytes.length <= 13);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), part.sha256);
      pieces.push(bytes);
    }
    assert.deepEqual(Buffer.concat(pieces), input);
    assert.equal(createHash('sha256').update(input).digest('hex'), result.archiveSha256);
    assert.doesNotMatch(result.command, /shasum|sha256/i);
    assert.match(result.command, /unzip/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the model pack record is platform independent and extracts into its own directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-models-'));
  try {
    const archive = join(root, 'webapps-0.1.20260915-models.tar.gz');
    await writeFile(archive, Buffer.from('a gzipped pack of hashed model files'));
    const result = await prepareReleaseFiles(archive, join(root, 'out'), { version: '0.1.20260915', platform: 'any', kind: 'models' });
    assert.deepEqual(Object.keys(result).sort(), ['bytes', 'command', 'kind', 'platform', 'sha256', 'url', 'version']);
    assert.equal(result.kind, 'models');
    assert.equal(result.platform, 'any');
    assert.equal(result.command, 'mkdir models\ntar -xzf webapps-0.1.20260915-models.tar.gz -C models');
    assert.deepEqual(JSON.parse(await readFile(join(root, 'out', 'any.json'), 'utf8')), result);
    assert.match(await readFile(join(root, 'out', 'webapps-0.1.20260915-models.tar.gz.install.txt'), 'utf8'), /Set NEURODESK_MODELS_DIR to its absolute path/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
