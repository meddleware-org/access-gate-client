// Shared by the live (real full node) tests that read events.
//
// Why: a public full node keeps only recent history. Once the package's events are older than its retention, `listEvents` does not answer with an empty
// page; it rejects with "requested data below earliest available; lowest available checkpoint is N" (seen on public testnet on 2026-11-21; the weekly
// live suite had been failing on it since 2026-11-02). That is not drift in this client, so the tests that read events skip when they see it, as they
// already skip when a page is empty. The read-indexer (sui-indexer) is the long-term source of history.
import type { TestContext } from 'vitest'

/** True if `error` is the node saying that the range asked for has been pruned. */
export function isPruned(error: unknown): boolean {
  // The node's own wording, carried in the message of the gRPC error.
  return error instanceof Error && /below earliest available/i.test(error.message)
}

/**
 * Run `read` and return its result. If the node reports the range as pruned, skip the calling test (a skipped test is reported, not hidden); any
 * other error is a real failure and is rethrown.
 */
export async function skipIfPruned<T>(ctx: TestContext, read: () => Promise<T>): Promise<T> {
  try {
    return await read()
  } catch (e) {
    // Only the pruning answer is excused.
    if (isPruned(e)) ctx.skip()
    throw e
  }
}
