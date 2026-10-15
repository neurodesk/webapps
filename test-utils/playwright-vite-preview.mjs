import { withBrowserBuild } from './playwright-build.mjs';
import { defineConfig, devices } from '@playwright/test';
import { e2eTier } from './e2e-tier.mjs';

// Playwright config for apps whose e2e suite runs against the BUILT output via
// `vite preview` (so deploy headers, worker/wasm asset paths and the base path
// are exercised — not just the dev server).
export function vitePreviewPlaywrightConfig({
  port,
  host = 'localhost',
  basePath = '/',
  // Adds a chromium project running SwiftShader via ANGLE — what NiiVue's own
  // e2e suite uses, and what makes WebGL2 available in headless Chromium on a
  // machine with no GPU.
  swiftShaderWebGL = false,
  // On a machine with http_proxy set, both Playwright's readiness probe and
  // Chromium itself would try to reach the local preview server through the
  // proxy, which answers 503. This exempts loopback before anything else runs.
  exemptLoopbackFromProxy = false,
  viewport,
  use = {},
  ...overrides
}) {
  if (exemptLoopbackFromProxy) {
    const noProxy = [process.env.NO_PROXY, process.env.no_proxy, host, 'localhost']
      .filter(Boolean).join(',');
    process.env.NO_PROXY = noProxy;
    process.env.no_proxy = noProxy;
  }
  const baseURL = `http://${host}:${port}${basePath}`;
  return defineConfig({
    ...e2eTier,
    testDir: './e2e',
    webServer: {
      command: withBrowserBuild(`pnpm preview --port ${port} --strictPort --host ${host}`),
      url: baseURL,
      reuseExistingServer: false,
      timeout: 180_000
    },
    use: {
      baseURL,
      ...(viewport ? { viewport } : {}),
      ...(process.env.PW_EXECUTABLE_PATH
        ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
        : {}),
      ...use
    },
    ...(swiftShaderWebGL
      ? {
          projects: [
            {
              name: 'chromium',
              use: {
                ...devices['Desktop Chrome'],
                headless: true,
                launchOptions: {
                  args: [
                    '--use-gl=angle',
                    '--use-angle=swiftshader',
                    '--enable-unsafe-swiftshader',
                    ...(viewport ? [`--window-size=${viewport.width},${viewport.height}`] : []),
                    ...(exemptLoopbackFromProxy ? ['--no-proxy-server'] : [])
                  ]
                }
              }
            }
          ]
        }
      : {}),
    ...overrides
  });
}
