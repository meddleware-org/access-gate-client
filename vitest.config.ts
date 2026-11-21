// Vitest settings for the default (offline) unit suite: `npm test`. The live read suite has its own config (vitest.integration.config.ts).
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Node, not jsdom: the package has no DOM code (the indexer reader uses `fetch`, which Node provides).
    environment: 'node',
    // Default (offline) unit suite. The gRPC read-path integration harness lives under
    // tests/integration and runs via vitest.integration.config.ts (gated by GRPC_TESTNET).
    include: ['tests/**/*.test.ts'],
    // The integration tests need a network and a gate (GRPC_TESTNET), so they are excluded from the default run.
    exclude: ['tests/integration/**', 'node_modules/**'],
  },
})
