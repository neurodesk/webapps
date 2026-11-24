import { createRequire } from 'node:module';
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';
import { isolationFallback } from '../../scripts/lib/isolation-fallback-plugin.mjs';
import { mindgrabAssets, mindgrabFromAssetPath } from '../../scripts/lib/mindgrab-asset-path-plugin.mjs';

const require = createRequire(import.meta.url);
const brainchopPackage = require.resolve('@brainchop/core/package.json');

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
// @brainchop/core loads WebGPU V4 weights, WebGL2 WASM, and threaded CPU WASM from assetPath.
export default neurodeskViteConfig({
  appId: 'brainchop',
  plugins: [
    isolationFallback(),
    mindgrabFromAssetPath(),
    mindgrabAssets({
      packageJson: brainchopPackage,
      models: ['mindmap', 'mindmap-fast', 'mindsnap'],
      directory: 'brainchop',
    }),
  ],
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  build: { target: 'esnext', outDir: 'dist', assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@brainchop/core'] },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
