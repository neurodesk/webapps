import { vitePreviewPlaywrightConfig } from '../../test-utils/playwright-vite-preview.mjs';

// NiiVue's viewer is WebGPU-only, so the page needs an adapter before the WASM defacing can be
// reached. These flags select Chromium's software adapter (SwiftShader) on every platform, so
// the spec runs the same way on a hosted runner with no GPU and on a developer machine.
const softwareWebGpu = [
  '--enable-unsafe-webgpu',
  '--use-webgpu-adapter=swiftshader',
  '--no-proxy-server',
  ...(process.platform === 'linux'
    ? ['--use-angle=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface']
    : []),
];

export default vitePreviewPlaywrightConfig({
  port: 4333,
  host: '127.0.0.1',
  basePath: '/deface/',
  use: { launchOptions: { args: softwareWebGpu } },
  exemptLoopbackFromProxy: true,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
});
