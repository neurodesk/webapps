import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 120000,
  workers: 1,
  webServer: {
    command: 'pnpm build && pnpm preview --port 4189 --strictPort',
    url: 'http://127.0.0.1:4189/brain-extraction/',
    reuseExistingServer: !process.env.CI,
    timeout: 600000,
  },
  use: {
    baseURL: 'http://127.0.0.1:4189/brain-extraction/',
    launchOptions: { args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader'] },
  },
});
