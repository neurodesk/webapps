import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cropTof, TOF_SOURCE, TOF_CROP } from '../../../apps/vesselboost/test/tof-crop.mjs';
export async function pinnedExample() {
  const directory = join(tmpdir(), 'vesselboost-validation');
  await mkdir(directory, { recursive: true });
  const sourcePath = join(directory, TOF_SOURCE.name);
  let source = await readFile(sourcePath).catch(() => null);
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  if (!source || hash(source) !== TOF_SOURCE.sha256) {
    const response = await fetch(TOF_SOURCE.url);
    if (!response.ok) throw new Error(`Pinned Lausanne example: HTTP ${response.status}`);
    source = Buffer.from(await response.arrayBuffer());
    if (hash(source) !== TOF_SOURCE.sha256)
      throw new Error('Pinned Lausanne example failed SHA-256 verification');
    await writeFile(sourcePath, source);
  }
  const bytes = await cropTof(source);
  const path = join(directory, TOF_CROP.name);
  await writeFile(path, bytes);
  return { path, bytes };
}
