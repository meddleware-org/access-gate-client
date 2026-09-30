import { defineConfig } from 'vitest/config'

// gRPC read-path integration harness (real Sui full node). Gated by GRPC_TESTNET so it self-skips
// when unset. Run with: GRPC_TESTNET=1 npm run test:integration
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.integration.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
})
