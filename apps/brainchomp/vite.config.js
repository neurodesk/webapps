import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs';
import { isolationFallback } from '../../scripts/lib/isolation-fallback-plugin.mjs';

// One shared owner supplies the app path, dev shell, theme, and isolation policy.
// public/brainchomp/ serves the unhashed WebGPU, WebGL2 and threaded CPU WASM modules.
export default neurodeskViteConfig({
  appId: 'brainchomp',
  plugins: [isolationFallback()],
  build: { target: 'esnext', outDir: 'dist', assetsInlineLimit: 0 },
  server: { host: '127.0.0.1' },
  preview: { host: '127.0.0.1' },
});
