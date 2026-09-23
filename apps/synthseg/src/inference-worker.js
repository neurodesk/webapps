import { loadSynthseg, runSynthseg } from '@neurodesk/synthseg';
import { browserRuntime, createBrowserSession } from '@neurodesk/synthseg/browser';
import wasmUrl from '@neurodesk/synthseg/wasm?url';

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const sha256 = async (bytes) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (v) =>
    v.toString(16).padStart(2, '0'),
  ).join('');

async function modelBytes(model) {
  let cache;
  try {
    cache = await caches.open('neurodesk-synthseg-v1');
  } catch {
    /* caching is optional */
  }
  let response = await cache?.match(model.url);
  if (!response) {
    response = await fetch(model.url);
    if (!response.ok || response.headers.get('content-type')?.includes('text/html'))
      throw new Error(
        'Could not download the SynthSeg weights. Check the connection and try again.',
      );
    // Cache only after verifying all bytes, below.
  }
  const length = Number(response.headers.get('content-length')) || model.bytes;
  const reader = response.body.getReader(),
    chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (received > model.bytes)
      throw new Error('The downloaded model exceeds its expected size and was rejected.');
    progress(
      0.12 + 0.13 * Math.min(1, received / (length || received)),
      `Loading model · ${(received / 1048576).toFixed(1)} MB`,
    );
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const hash = await sha256(bytes);
  if (hash !== model.sha256) {
    await cache?.delete(model.url);
    throw new Error('Model checksum mismatch. The downloaded file was rejected.');
  }
  try {
    await cache?.put(
      model.url,
      new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } }),
    );
  } catch {
    /* quota/private mode */
  }
  return { bytes, hash };
}

self.onmessage = async ({ data: job }) => {
  try {
    const wasm = await loadSynthseg(fetch(wasmUrl));
    const { buffer, provenance } = await runSynthseg({
      buffer: await job.file.arrayBuffer(),
      options: job.options,
      wasm,
      loadModel: () => modelBytes(job.model),
      createSession: createBrowserSession,
      onProgress: progress,
      runtime: { app: 'SynthSeg web 0.3.20260923', ...browserRuntime() },
    });
    self.postMessage({ type: 'result', buffer, provenance }, [buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
