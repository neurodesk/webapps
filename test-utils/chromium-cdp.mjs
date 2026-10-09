import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout } from 'node:timers/promises';

/** @param {string} directory @param {{ signal?: AbortSignal, timeout?: number }} options */
export async function waitForChromiumEndpoint(directory, { signal, timeout = 10000 } = {}) {
  const ready = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(timeout),
  ]);
  for (;;) {
    ready.throwIfAborted();
    try {
      const contents = await readFile(join(directory, 'DevToolsActivePort'), { encoding: 'utf8', signal: ready });
      const [port, endpoint] = contents.trim().split('\n');
      if (/^\d+$/.test(port) && endpoint?.startsWith('/devtools/browser/')) {
        return `ws://127.0.0.1:${port}${endpoint}`;
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await setTimeout(25, undefined, { signal: ready });
  }
}
