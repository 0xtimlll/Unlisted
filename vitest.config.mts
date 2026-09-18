import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) }

// `npm run test:unit`        -> pure tests only (default project)
// `npm run test:integration` -> live-RPC read-only tests (network required)
export default defineConfig({
  resolve: { alias },
  test: {
    environment: 'node',
    projects: [
      {
        resolve: { alias },
        test: { name: 'unit', include: ['tests/core/**/*.test.ts'] },
      },
      {
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          testTimeout: 60_000,
          hookTimeout: 60_000,
          retry: 1,
        },
      },
    ],
  },
})
