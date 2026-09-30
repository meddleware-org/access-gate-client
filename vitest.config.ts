import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // Default (offline) unit suite. The gRPC read-path integration harness lives under
    // tests/integration and runs via vitest.integration.config.ts (gated by GRPC_TESTNET).
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
  },
})
