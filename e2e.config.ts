import type { E2EConfig } from 'e2e';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { catalogBrowser, catalogEngine } from './test-utils/agentic-browser.ts';
import { neurodeskRequest } from './test-utils/neurodesk-request.mjs';

const neurodesk = createOpenAICompatible({
  name: 'neurodesk',
  baseURL: 'https://llm.neurodesk.org/openai',
  apiKey: process.env.NEURODESK_API_KEY,
  supportsStructuredOutputs: true,
  transformRequestBody: neurodeskRequest,
});

export default {
  projectId: 'neurodesk-webapps',
  tests: ['test/agentic/*.e2e.ts'],
  workers: 1,
  retries: 0,
  timeout: 900000,
  actionTimeout: 60000,
  assertionTimeout: 60000,
  trace: 'retain-on-failure',
  output: process.env.E2E_OUTPUT ?? '.e2e',
  reporters: ['list', 'junit'],
  ...(process.env.NEURODESK_API_KEY ? { secrets: { neurodeskApiKey: process.env.NEURODESK_API_KEY } } : {}),
  agents: {
    default: {
      model: neurodesk.chatModel('neurodesk'),
      maxSteps: 40,
      maxModelCalls: 50,
      judgmentTimeout: 120000,
      system: 'Test only the current Neurodesk app using its visible controls. Use the provided public example data. This Neurodesk model accepts text only: do not request screenshots or use coordinate actions. Use semantic controls, keyboard input and scrolling. Keep processing local unless the test explicitly configures a reference compute server. Report errors as failures. Preserve settings and assertions. Do not substitute outputs, change the app, or navigate to external services.',
    },
  },
  targets: ['desktop', 'phone'].map(name => ({
    name,
    engine: catalogEngine({
      browser: catalogBrowser(),
      viewport: name === 'phone' ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    }),
    app: process.env.E2E_BASE_URL ? { url: process.env.E2E_BASE_URL } : {
      url: 'http://127.0.0.1:0',
      command: {
        executable: process.execPath,
        args: ['scripts/serve-agentic-site.mjs'],
        log: `${process.env.E2E_OUTPUT ?? '.e2e'}/${name}-server.log`,
        env: {
          PORT: '{port}',
          E2E_SITE_DIR: process.env.E2E_SITE_DIR ?? 'dist',
        },
      },
    },
  })),
} satisfies E2EConfig;
