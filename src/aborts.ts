/**
 * @file Abort codes of the `access_gate` Move module, and the finder that turns a failed transaction's error into a user-facing message.
 *
 * Role: a wallet or a node reports a Move abort in one of several shapes (an SDK error object, a failed status, or text). `abortMessage` finds the abort
 * in any of them and claims it only when it came from **this** package's `access_gate`, so a look-alike package's code 5 is never explained as ours.
 *
 * Main exports: `ACCESS_GATE_ABORTS`, `abortMessage`. The table must match `sources/access_gate.move`'s `E_*` constants; `tests/abi-table.test.ts` and
 * `tests/aborts.test.ts` check it, and the integration test reads the live package.
 */
// Addresses are compared in normalised form (64 digits), so `0x2` and its padded spelling are the same package.
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { ACCESS_GATE_MODULE } from './typeNames.js'

/** An `access_gate` abort code: its Move constant and a message fit for a user. */
export interface AccessGateAbort {
  /** The Move constant's name, as in `sources/access_gate.move`. */
  name: string
  /** A sentence fit to show a person, saying what to do rather than quoting the code. */
  message: string
}

/**
 * `access_gate` abort codes (`sources/access_gate.move`, `E_*` constants). Frozen, so a consumer cannot change what every other consumer shows.
 */
export const ACCESS_GATE_ABORTS: Readonly<Record<number, AccessGateAbort>> = Object.freeze({
  1: { name: 'E_PAUSED', message: 'This gate is paused.' },
  2: { name: 'E_INSUFFICIENT_PAYMENT', message: 'The payment is less than the gate price.' },
  3: { name: 'E_NOT_SINGLE_USE', message: 'This pass is unlimited; it has no uses to spend.' },
  4: { name: 'E_NO_USES_REMAINING', message: 'This NFT has no uses left.' },
  5: { name: 'E_WRONG_GATE', message: 'The NFT or admin cap belongs to a different gate.' },
  6: { name: 'E_GATE_FROZEN', message: 'This gate is immutable; it can no longer be changed.' },
  7: { name: 'E_COMMISSION_TOO_HIGH', message: 'The commission exceeds the 10% cap.' },
  8: { name: 'E_INVALID_NONCE', message: 'The access nonce is too short.' },
  9: { name: 'E_ZERO_ADDRESS', message: 'The treasury or the gate\'s payment recipient cannot be the zero address.' },
  10: { name: 'E_FREEZE_WHILE_PAUSED', message: "This gate's policy forbids freezing it while paused." },
  11: { name: 'E_PRICE_TOO_LOW', message: 'The price is below the platform minimum for a paid gate.' },
  12: { name: 'E_FREE_FEE_UNPAID', message: 'Pay the free-gate fee before setting the price to 0.' },
  13: {
    name: 'E_WRONG_VERSION',
    message: 'This version of the access-gate contract has been retired; reload to use the current one.',
  },
  14: { name: 'E_NOT_UPGRADE', message: 'The platform is already at this contract version.' },
  15: {
    name: 'E_POLICY_COMBINATION',
    message:
      'This gate policy is invalid: if pausing blocks decryption or access, freezing must also require the gate to be unpaused.',
  },
  16: {
    name: 'E_USES_KIND_IMMUTABLE',
    message:
      'A gate cannot switch between unlimited and single-use passes; only the number of uses of a single-use gate can change.',
  },
})

/** How deep `findAbort` follows `.error` wrappers (a two-object cycle must not overflow the stack). */
const MAX_ERROR_DEPTH = 8

/** Where an abort came from, as far as the error shows. */
interface AbortSite {
  /** The abort code (the Move constant's value). */
  code: number
  /** The module the abort came from, when the error names it. */
  module?: string
  /** Package address (normalised), when the error names it. */
  package?: string
}

/**
 * Find a Move abort in `error`: an SDK `ExecutionError` / `SimulationError`, a failed
 * transaction's status, or error text in the SDK's or a wallet's format.
 */
function findAbort(error: unknown, depth = 0): AbortSite | null {
  if (depth > MAX_ERROR_DEPTH) return null // a cyclic or absurdly nested `.error` chain
  // First, the structured shapes: an object with a `MoveAbort`, directly or under `executionError`.
  if (error && typeof error === 'object') {
    const o = error as Record<string, unknown>
    const abort = (o.MoveAbort ?? (o.executionError as Record<string, unknown> | undefined)?.MoveAbort) as
      | { abortCode?: string | number; location?: { package?: string; module?: string } }
      | undefined
    if (abort?.abortCode !== undefined) {
      // The code may arrive as a string (a u64 from JSON) or a number.
      const code = Number(abort.abortCode)
      if (Number.isSafeInteger(code)) {
        return {
          code,
          module: abort.location?.module,
          package: abort.location?.package ? normalizeSuiAddress(abort.location.package) : undefined,
        }
      }
    }
    // SDK errors wrap the cause in `.error`; follow it, but never into itself.
    if (o.error !== undefined && o.error !== error) {
      const nested = findAbort(o.error, depth + 1)
      if (nested) return nested
    }
  }
  // Then the text shapes: an Error's message, or a bare string.
  const text = error instanceof Error ? error.message : typeof error === 'string' ? error : null
  if (!text) return null

  // SDK: "MoveAbort in 2nd command, abort code: 5, in '0x…::access_gate::consume' (instruction 12)"
  const sdk = /abort code: (\d+), in '(0x[0-9a-fA-F]+)::(\w+)/.exec(text)
  if (sdk?.[1] && sdk[2] && sdk[3]) return { code: Number(sdk[1]), package: normalizeSuiAddress(sdk[2]), module: sdk[3] }
  // Node/wallet: "MoveAbort(MoveLocation { module: ModuleId { address: 1a81…, name: Identifier("access_gate") }, …}, 5)"
  const node = /MoveAbort\(MoveLocation \{ module: ModuleId \{ address: (0x)?([0-9a-fA-F]+), name: Identifier\("(\w+)"\) \}.*?\}, (\d+)\)/.exec(
    text,
  )
  if (node?.[2] && node[3] && node[4]) {
    return { code: Number(node[4]), package: normalizeSuiAddress(node[2]), module: node[3] }
  }
  return null
}

/**
 * The user-facing message for an `access_gate` abort in `error`, or `null` if it holds none.
 * Only aborts located in the `access_gate` module of **this** package count (`originalId`: modules keep
 * their original id across upgrades). Without it, any package's `access_gate` would be claimed — a look-alike,
 * or a superseded package whose codes 13 and 14 meant something else. An abort whose location the error
 * does not show is not claimed.
 */
export function abortMessage(error: unknown, originalId: string): string | null {
  const site = findAbort(error)
  // Not ours unless it is in the `access_gate` module...
  if (!site || site.module !== ACCESS_GATE_MODULE) return null
  // ...of this package (an abort whose package the error does not show is not claimed either).
  if (site.package !== normalizeSuiAddress(originalId)) return null
  // An unknown code gives null: better no message than a wrong one.
  return ACCESS_GATE_ABORTS[site.code]?.message ?? null
}
