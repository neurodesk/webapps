// Keep dwi2trx on the shared Vite, shell, theme, and isolation policy used by
// the other bundled Neurodesk apps.
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs'
import { mindgrabFromAssetPath } from '../../scripts/lib/mindgrab-asset-path-plugin.mjs'

export default neurodeskViteConfig({
  appId: 'dwi2trx',
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  // The tensor worker always passes assetPath, so MindGrab loads its modules from brainchop/.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  // These browser runtimes load WASM or WGSL assets through native module URLs.
  // Vite's development prebundler cannot process those imports.
  optimizeDeps: {
    exclude: ['@dipy/gpu-streamlines', '@niivue/dcm2niix', '@niivue/niimath'],
  },
})
