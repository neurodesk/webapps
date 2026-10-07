import { defineConfig } from '@playwright/test';

// Serve the BUILT output so the shared preview headers and worker/wasm asset
// paths are exercised — not just the dev server.
export default defineConfig({
  testDir: './e2e',
  webServer: {
    env: process.env.TOPOFIT_ASSET_DIR ? { VITE_TOPOFIT_ASSET_BASE: '/model-assets/' } : {},
    command: 'pnpm build && pnpm preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
  use: { baseURL: 'http://localhost:4173' },
  // A real reconstruction uses every core and several gigabytes; running it beside the
  // viewer tests made their 30 s waits time out on 4-core CI runners. It runs alone, last.
  projects: [
    { name: 'interface', grepInvert: /@inference/ },
    { name: 'inference', grep: /@inference/, dependencies: ['interface'] },
  ],
});
