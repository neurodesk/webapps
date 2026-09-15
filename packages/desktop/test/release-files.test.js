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
    assert.match(result.command, /shasum -a 256/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
