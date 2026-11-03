import { staticAppPlaywrightConfig } from '../../test-utils/playwright-static-app.mjs';

const port = 4321;
const config = staticAppPlaywrightConfig({ port });

export default {
  ...config,
  webServer: {
    ...config.webServer,
    command: `${process.env.NEURODESK_E2E_PREBUILT ? '' : 'pnpm build && '}node ../../scripts/dev-server.mjs --dir dist --port ${port} --cache-policy no-store --staging-route /__lnm_downloads/`,
    reuseExistingServer: false,
    timeout: 120000,
  },
};
