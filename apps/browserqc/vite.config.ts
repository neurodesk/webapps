import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs'
import { mindgrabFromAssetPath } from '../../scripts/lib/mindgrab-asset-path-plugin.mjs'

// Base path, worker format, COOP/COEP dev headers and the production _headers
// file come from the shared helper (registry path: /browserqc/).
export default neurodeskViteConfig({
  appId: 'browserqc',
  // MindGrab always loads its modules from brainchop/<version>/ (the worker passes assetPath; the page
  // only reads MODELS), so neither bundle needs its fallback copies.
  plugins: [mindgrabFromAssetPath()],
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  server: {
    open: '/index.html',
    port: 8091,
  },
  build: {
    target: 'esnext',
  },
  // Vite's dev dep-prebundler cannot resolve @niivue/dcm2niix's WASM worker
  // after it moves under .vite/deps. Keep that package as source in dev. The
  optimizeDeps: {
    exclude: ['@niivue/dcm2niix', '@niivue/niimath', '@brainchop/mindgrab'],
  },
})
