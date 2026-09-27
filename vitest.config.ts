import {defineConfig} from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // the flows run against an in-process mock mint over real HTTP
    testTimeout: 20_000
  }
})
