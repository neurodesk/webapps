import { createRequire } from 'node:module'
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs'
import { mindgrabAssets, mindgrabFromAssetPath } from '../../scripts/lib/mindgrab-asset-path-plugin.mjs'

// Resolve MindGrab through the package that pins it, not the app's own install.
const require = createRequire(import.meta.resolve('@neurodesk/deface/browser'))
const runtimeRequire = createRequire(require.resolve('@neurodesk/runtime-support/mindgrab'))
const mindgrabPackage = runtimeRequire.resolve('@brainchop/core/package.json')

// Base path, worker format, COOP/COEP dev headers and the production _headers
// file come from the shared helper (registry path: /deface/).
export default neurodeskViteConfig({
  appId: 'deface',
  plugins: [mindgrabAssets({ packageJson: mindgrabPackage, models: ['mindgrab'] })],
  // The MindGrab worker always passes assetPath, so its modules load from the mindgrab/ copies.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  server: {
    port: 8091,
  },
  build: {
    target: 'esnext',
  },
  // Vite's dev dep-prebundler cannot resolve @niivue/dcm2niix's WASM worker
  // after it moves under .vite/deps. Keep that package as source in dev. The
  // niimath runtime comes from the workspace runtime-support package, and Vite
  // resolves its worker assets from source during dev and build.
  optimizeDeps: {
    exclude: ['@niivue/dcm2niix', '@brainchop/core'],
  },
})
