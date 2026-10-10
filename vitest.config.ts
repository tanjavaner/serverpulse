import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      { find: '@shared', replacement: resolve('src/shared') },
      // Gerçek electron paketi Node'da binary yolunu döndürür ve binary yoksa indirmeye çalışır (CI'da yok)
      { find: /^electron$/, replacement: resolve('tests/stubs/electron.ts') }
    ]
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
