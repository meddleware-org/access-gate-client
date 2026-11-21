import { defineConfig } from 'vitest/config'

// gRPC read-path integration harness (real Sui full node). Gated by GRPC_TESTNET so it self-skips
// when unset. Run with: GRPC_TESTNET=1 npm run test:integration
//
// It is read-only and needs no key: it compares the client's expectations (the ABI table, the struct schemas, the pass-variant rendering) with the
// deployed package. CI runs it weekly (.github/workflows/live-read.yml), not on every push, because a public node can be slow or rate-limited.
export default defineConfig({
  test: {
    environment: 'node',
    // Only the integration files, which are named `*.integration.test.ts` so the default config never picks them up.
    include: ['tests/integration/**/*.integration.test.ts'],
    // A real node is slow: a minute per test and per hook.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // One file at a time, so a shared public node is not hit by several suites at once.
    fileParallelism: false,
  },
})
