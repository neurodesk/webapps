import { defineConfig } from '@playwright/test';

export function staticAppPlaywrightConfig({ port }) {
  const baseURL = `http://localhost:${port}`;
  return defineConfig({
    testDir: './e2e',
    webServer: {
      command: `pnpm vendor && bash web/run.sh ${port}`,
      url: `${baseURL}/harness.html`,
      reuseExistingServer: !process.env.CI,
      timeout: 60000
    },
    use: {
      baseURL,
      ...(process.env.PW_EXECUTABLE_PATH
        ? { launchOptions: { executablePath: process.env.PW_EXECUTABLE_PATH } }
        : {})
    }
  });
}
