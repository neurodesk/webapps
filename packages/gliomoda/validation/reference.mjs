import { createHash } from 'node:crypto';
import reference from './container-reference.json' with { type: 'json' };

/** Fetch a pinned container output and verify it before using it as a scientific reference. */
export async function readContainerReference(file) {
  const run = reference.runs.find((entry) => entry.file === file);
  if (!run) throw new Error(`Unknown container reference: ${file}`);
  const response = await fetch(new URL(file, reference.container.outputs));
  if (!response.ok) throw new Error(`Container reference ${file}: HTTP ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== run.sha256) throw new Error(`Container reference checksum mismatch: ${file}`);
  return bytes;
}
