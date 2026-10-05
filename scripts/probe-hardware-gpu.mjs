#!/usr/bin/env node
// Launches Chromium the way the e2e suites do and fails unless WebGL2 and
// WebGPU both reach a hardware adapter. CI runs it before the macOS GPU suites
// so a runner image without Metal fails here instead of as an inference timeout.
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';
import { assertHardwareAdapter, gpuBrowser, hardwareGpu, readAdapterInfo } from '../test-utils/hardware-gpu.mjs';

if (!hardwareGpu) throw new Error('Set NEURODESK_HARDWARE_GPU=1 to probe the hardware GPU launch');

// navigator.gpu only exists in a secure context, which about:blank is not.
const server = createServer((request, response) => response.end('<!doctype html><title>GPU probe</title>'));
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ channel: gpuBrowser.channel, ...gpuBrowser.launchOptions });
try {
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  const webgl2 = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
  });
  const webgpu = await readAdapterInfo(page);
  console.log(JSON.stringify({ browser: browser.version(), webgl2, webgpu }, null, 2));
  if (!webgl2 || /swiftshader|llvmpipe|software/i.test(webgl2)) {
    throw new Error(`WebGL2 is not on hardware: ${webgl2}`);
  }
  assertHardwareAdapter(webgpu);
} finally {
  await browser.close();
  server.close();
}
