import { normalizeSuiAddress } from '@mysten/sui/utils'
import { ACCESS_GATE_MODULE } from './typeNames.js'

/** An `access_gate` abort code: its Move constant and a message fit for a user. */
export interface AccessGateAbort {
  name: string
  message: string
}

/** `access_gate` abort codes (`sources/access_gate.move`, `E_*` constants). */
export const ACCESS_GATE_ABORTS: Readonly<Record<number, AccessGateAbort>> = Object.freeze({
  1: { name: 'E_PAUSED', message: 'This gate is paused.' },
  2: { name: 'E_INSUFFICIENT_PAYMENT', message: 'The payment is less than the gate price.' },
  3: { name: 'E_NOT_SINGLE_USE', message: 'This pass is unlimited; it has no uses to spend.' },
  4: { name: 'E_NO_USES_REMAINING', message: 'This NFT has no uses left.' },
  5: { name: 'E_WRONG_GATE', message: 'The NFT or admin cap belongs to a different gate.' },
  6: { name: 'E_GATE_FROZEN', message: 'This gate is immutable; it can no longer be changed.' },
  7: { name: 'E_COMMISSION_TOO_HIGH', message: 'The commission exceeds the 10% cap.' },
  8: { name: 'E_INVALID_NONCE', message: 'The access nonce is too short.' },
  9: { name: 'E_ZERO_ADDRESS', message: 'The treasury cannot be the zero address.' },
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
  code: number
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
  if (error && typeof error === 'object') {
    const o = error as Record<string, unknown>
    const abort = (o.MoveAbort ?? (o.executionError as Record<string, unknown> | undefined)?.MoveAbort) as
      | { abortCode?: string | number; location?: { package?: string; module?: string } }
      | undefined
    if (abort?.abortCode !== undefined) {
      const code = Number(abort.abortCode)
      if (Number.isSafeInteger(code)) {
        return {
          code,
          module: abort.location?.module,
          package: abort.location?.package ? normalizeSuiAddress(abort.location.package) : undefined,
        }
      }
    }
    if (o.error !== undefined && o.error !== error) {
      const nested = findAbort(o.error, depth + 1)
      if (nested) return nested
    }
  }
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
  if (!site || site.module !== ACCESS_GATE_MODULE) return null
  if (site.package !== normalizeSuiAddress(originalId)) return null
  return ACCESS_GATE_ABORTS[site.code]?.message ?? null
}
