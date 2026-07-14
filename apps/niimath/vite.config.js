import { defineConfig } from 'vite'

export default defineConfig({
  root: '.',
  base: process.env.WEBAPPS_BASE_PATH || './',
  server: {
    open: 'index.html'
  },
  build: {
    rollupOptions: {
      output: {
        format: 'es'
      }
    }
  },
  worker: {
    format: 'es'
  },
  // exclude @niivue/niimath from optimization
  optimizeDeps: {
    exclude: ['@niivue/niimath']
  }
})
