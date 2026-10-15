import { defineConfig } from 'vitest/config'

export default defineConfig(({ mode }) => ({
  test: {
    include: [mode === 'phone' ? 'src/**/*.phone.ts' : 'src/**/*.test.ts'],
  },
  server: {
    proxy: {
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
}))
