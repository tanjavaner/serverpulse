import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const shared = { '@shared': resolve('src/shared') }

export default defineConfig({
  main: {
    resolve: { alias: shared },
    build: {
      rollupOptions: {
        // node:sqlite yalnızca "node:" önekiyle var olan bir builtin; bundler'a dışarıda bırakmasını açıkça söylüyoruz.
        external: ['node:sqlite']
      }
    }
  },
  preload: {
    resolve: { alias: shared }
  },
  renderer: {
    resolve: { alias: shared },
    plugins: [react(), tailwindcss()],
    build: {
      minify: 'esbuild',
      chunkSizeWarningLimit: 1500,
      rollupOptions: {
        input: {
          widget: resolve('src/renderer/widget.html'),
          dashboard: resolve('src/renderer/dashboard.html')
        }
      }
    }
  }
})
