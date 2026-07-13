import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs'

// Plugin to copy Pyodide files for offline support
function copyPyodidePlugin() {
  return {
    name: 'copy-pyodide',
    closeBundle() {
      const srcDir = resolve(__dirname, 'public/pyodide')
      const destDir = resolve(__dirname, 'out/renderer/pyodide')

      if (existsSync(srcDir)) {
        console.log('📦 Copying Pyodide files for offline support...')
        mkdirSync(destDir, { recursive: true })
        cpSync(srcDir, destDir, { recursive: true })
        console.log('✅ Pyodide files copied to', destDir)
      } else {
        console.log('⚠️  No Pyodide files found in public/pyodide')
        console.log('   Run: npm run download:pyodide')
      }
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/main.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload.ts')
        }
      }
    }
  },
  renderer: {
    root: '.',
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      },
      // Copy public folder assets including pyodide
      copyPublicDir: true
    },
    publicDir: 'public',
    plugins: [react(), copyPyodidePlugin()],
    server: {
      port: 3001
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    // Use ES module format for workers (required for code-splitting compatibility)
    worker: {
      format: 'es'
    }
  }
})
