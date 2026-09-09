import {defineConfig} from 'vitest/config'
import solid from 'vite-plugin-solid'
export default defineConfig({
  plugins: [solid()],
  test: {
    environment: 'node',
    include: ['tests/integration/*.test.ts'],
    testTimeout: 120000,
    hookTimeout: 30000
  }
})
