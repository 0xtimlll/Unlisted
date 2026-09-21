import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Same stand-ins as next.config.ts, so tests exercise the code the browser runs (shims/README.md).
const alias = {
  '@': fileURLToPath(new URL('./src', import.meta.url)),
  '@layerzerolabs/lz-utilities': fileURLToPath(new URL('./shims/lz-utilities/index.js', import.meta.url)),
  '@layerzerolabs/lz-foundation': fileURLToPath(new URL('./shims/lz-foundation/index.js', import.meta.url)),
}
// Vite's object aliases are prefix matches; the root entry must be replaced without touching `/umi`.
const aliasList = [
  ...Object.entries(alias).map(([find, replacement]) => ({ find, replacement })),
  { find: /^@layerzerolabs\/lz-solana-sdk-v2$/, replacement: fileURLToPath(new URL('./shims/lz-solana-sdk-v2/index.js', import.meta.url)) },
]

// `npm run test:unit`        -> pure tests only (default project)
// `npm run test:integration` -> live-RPC read-only tests (network required)
// The LayerZero SDK is processed by Vite (not loaded straight by Node) so the aliases above apply
// inside it too.
const server = { deps: { inline: [/@layerzerolabs\//] } }

export default defineConfig({
  resolve: { alias: aliasList },
  test: {
    environment: 'node',
    server,
    projects: [
      {
        resolve: { alias: aliasList },
        test: { name: 'unit', include: ['tests/core/**/*.test.ts'], server },
      },
      {
        resolve: { alias: aliasList },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          server,
          testTimeout: 60_000,
          hookTimeout: 60_000,
          retry: 1,
        },
      },
    ],
  },
})
