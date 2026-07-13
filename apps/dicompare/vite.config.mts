import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  base: process.env.WEBAPPS_BASE_PATH || (mode === 'test' ? '/' : '/dicompare/'),
  plugins: [react()],
  server: {
    port: 3001,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: true
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
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/setupTests.ts',
  },
}))
