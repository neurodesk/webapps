import { loadAppContract } from '../../scripts/lib/app-automation.mjs'
import { writeRuntimeCacheManifest } from '../../scripts/lib/runtime-cache.mjs'
import { resolve } from 'node:path'
import { contractJsonSchema } from '../../packages/desktop/src/contracts.js'
import metadata from './package.json'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

function runtimeCachePlugin(): Plugin {
  let distDir: string
  return {
    name: 'dicompare-runtime-cache',
    apply: 'build',
    configResolved(config) {
      distDir = resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await writeRuntimeCacheManifest({ distDir })
    },
  }
}

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: process.env.WEBAPPS_BASE_PATH || (mode === 'test' ? '/' : '/dicompare/'),
  plugins: [react(), runtimeCachePlugin(), {
    name: 'dicompare-automation-contract',
    async generateBundle() {
      const contract = await loadAppContract({ id: 'dicompare' }, metadata.version)
      this.emitFile({ type: 'asset', fileName: 'automation.json', source: JSON.stringify(contract, null, 2) })
      this.emitFile({ type: 'asset', fileName: 'automation.schema.json', source: JSON.stringify(contractJsonSchema(), null, 2) })
    },
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        if (!new URL(request.url || '/', 'http://localhost').pathname.endsWith('/automation.json')) return next()
        const contract = await loadAppContract({ id: 'dicompare' }, metadata.version)
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(contract))
      })
    },
  }],
  server: {
    port: 3001,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  },
  worker: {
    format: 'es',
  },
  optimizeDeps: {
    exclude: ['@niivue/dcm2niix'],
  },
  resolve: {
    alias: {
      '@': '/src',
    },
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,jsx,ts,tsx}'],
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
}))
