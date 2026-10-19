import { test } from '@playwright/test';
import { mindgrabAutoOnSoftwareRenderer } from './mindgrab-auto.mjs';

// Chromium's SwiftShader WebGPU adapter lacks shader-f16, so MindGrab's `auto` moves on to
// SwiftShader WebGL2: the desktop under xvfb and a hosted runner (neurodesk/webapps#394).
test.use({ launchOptions: { args: ['--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader', '--use-vulkan=swiftshader', '--enable-features=Vulkan', '--disable-vulkan-surface'] } });

test('MindGrab auto with a software WebGPU adapter runs the CPU module and returns a brain mask', async ({ page }) => {
  await mindgrabAutoOnSoftwareRenderer(page, 'software WebGPU adapter');
});
