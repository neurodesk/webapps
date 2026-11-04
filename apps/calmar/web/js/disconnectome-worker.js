// Module Web Worker scoring a lesion against the ENIGMA tract atlas for the
// knowledge-base report: opens the TVX atlas once (the bytes arrive from the
// main thread, which fetched and cached them through the manifest asset
// loader) and answers each query with the fraction of every bundle's
// streamlines passing through the lesion. The engine is nii2tvx compiled to
// WebAssembly (packages/nii2tvx), shared with the Disconnectome webapp, so a
// bundle fraction here equals that app's TSV to six significant digits.
//
// Protocol (postMessage):
//   { id, type: 'query', lesion: ArrayBuffer (NIfTI on the atlas grid),
//     atlas?: ArrayBuffer, atlasKey: string }  -> { id, type: 'result', tracts, fractions }
//   any failure                                -> { id, type: 'error', message }
// The atlas buffer is needed only the first time an atlasKey is seen.
import { openAtlas } from '../vendor/nii2tvx/src/index.js';

const opened = new Map();

self.onmessage = async ({ data: job }) => {
  const reply = (message, transfer) => self.postMessage({ id: job?.id ?? null, ...message }, transfer || []);
  try {
    if (!job || job.type !== 'query') throw new Error(`disconnectome worker: unknown message ${job?.type}`);
    const key = String(job.atlasKey || 'atlas');
    if (!opened.has(key)) {
      if (!job.atlas) throw new Error('disconnectome worker: the atlas bytes are needed for the first query');
      opened.set(key, openAtlas(new Uint8Array(job.atlas)).catch((error) => {
        opened.delete(key);
        throw error;
      }));
    }
    const atlas = await opened.get(key);
    const fractions = await atlas.query(new Uint8Array(job.lesion));
    reply({ type: 'result', tracts: atlas.tracts, fractions }, [fractions.buffer]);
  } catch (error) {
    reply({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
