// Keep dwi2trx on the shared Vite, shell, theme, and isolation policy used by
// the other bundled Neurodesk apps.
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { neurodeskViteConfig } from '../../scripts/lib/vite-app-config.mjs'
import { mindgrabFromAssetPath } from '../../scripts/lib/mindgrab-asset-path-plugin.mjs'

const require = createRequire(import.meta.url)
const niimathLicensePath = join(dirname(require.resolve('@niivue/niimath/package.json')), 'LICENSE')

function niimathLicense() {
  return {
    name: 'niimath-license',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'niimath/LICENSE', source: await readFile(niimathLicensePath) })
    },
  }
}

export default neurodeskViteConfig({
  appId: 'dwi2trx',
  plugins: [niimathLicense()],
  build: { target: 'es2022', outDir: 'dist', assetsInlineLimit: 0 },
  // The tensor worker always passes assetPath, so MindGrab loads its modules from brainchop/.
  worker: { plugins: () => [mindgrabFromAssetPath()] },
  // These browser runtimes load WASM or WGSL assets through native module URLs.
  // Vite's development prebundler cannot process those imports.
  optimizeDeps: {
    exclude: ['@dipy/gpu-streamlines', '@niivue/dcm2niix', '@niivue/niimath', '@brainchop/core'],
  },
})
