import { chromium } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { web, type BrowserProvider, type WebOptions } from '@e2e-dev/web';
import { defineEngine } from 'e2e/engine';

// Downloads are relative to the current attempt, rather than the working directory.
export function catalogEngine(options: WebOptions) {
  const { capabilities: _capabilities, ...engine } = web(options);
  const observe = engine.observe;
  if (!observe) throw new Error('The catalog browser must provide semantic observations.');
  let artifactsDir = '';
  return defineEngine({
    ...engine,
    observe: (context, options) => observe(context, { ...options, pixels: false }),
    fixtures: {
      ...engine.fixtures,
      downloads: context => context.fixture('downloads', {
        resolve: (path: string) => join(artifactsDir, path),
      }, {}),
    },
    async startAttempt(context) {
      artifactsDir = context.artifactsDir;
      await engine.startAttempt?.(context);
    },
  });
}

// The web engine has no launch-args option. Its provider contract preserves
// the catalog's existing software WebGL/WebGPU configuration on Linux CI.
export function catalogBrowser(): BrowserProvider {
  const downloadsDir = join(tmpdir(), `agentic-downloads-${randomUUID()}`);
  const servers = new Map<string, { context: Awaited<ReturnType<typeof chromium.launchPersistentContext>>; directory: string }>();
  return {
    name: 'local-chromium',
    scope: 'attempt',
    downloads: {
      dir: downloadsDir,
      async read(_lease, file, { signal }) {
        signal.throwIfAborted();
        if (!file.startsWith(`${downloadsDir}/`)) throw new Error('Download escaped its browser directory.');
        return readFile(file, { signal });
      },
    },
    async acquire(request) {
      request.signal.throwIfAborted();
      const directory = await mkdtemp(join(tmpdir(), 'agentic-chromium-'));
      const context = await chromium.launchPersistentContext(directory, {
        headless: request.env.E2E_HEADED !== '1',
        ...(request.env.E2E_CHROMIUM_EXECUTABLE ? { executablePath: request.env.E2E_CHROMIUM_EXECUTABLE } : {}),
        timeout: 60000,
        args: ['--remote-debugging-port=0', ...(process.platform === 'linux' && request.env.E2E_SOFTWARE_GPU !== '0' ? [
          '--enable-unsafe-webgpu',
          '--use-angle=swiftshader',
          '--use-vulkan=swiftshader',
          '--enable-features=Vulkan',
          '--disable-vulkan-surface',
        ] : [])],
      }).catch(async error => {
        await rm(directory, { recursive: true, force: true });
        throw error;
      });
      if (request.signal.aborted) {
        await context.close();
        await rm(directory, { recursive: true, force: true });
        request.signal.throwIfAborted();
      }
      const id = `${request.runId}-${request.targetName}-${request.slot}`;
      try {
        const [port, endpoint] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
        servers.set(id, { context, directory });
        return { id, cdpEndpoint: `ws://127.0.0.1:${port}${endpoint}` };
      } catch (error) {
        await context.close();
        await rm(directory, { recursive: true, force: true });
        throw error;
      }
    },
    async release(lease) {
      const server = servers.get(lease.id);
      servers.delete(lease.id);
      if (server) {
        try {
          await server.context.close();
        } finally {
          await rm(server.directory, { recursive: true, force: true });
          await rm(downloadsDir, { recursive: true, force: true });
        }
      }
    },
  };
}
