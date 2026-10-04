import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

test('failed upstream validation cannot leave an earlier passing report', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'musclemap-validator-'));
  const report = join(directory, 'report.json');
  try {
    await writeFile(report, JSON.stringify({ status: 'passed' }));
    await assert.rejects(promisify(execFile)(process.execPath, [
      new URL('../scripts/validate_upstream_parity.mjs', import.meta.url).pathname,
      '--case', 'missing-reference-case', '--report', report
    ]), /Unknown controlled reference case/);
    await assert.rejects(readFile(report), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
