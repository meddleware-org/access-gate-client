import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'

// Strict readers for Move values as a full node renders them in an object's `json`: u64 as a
// decimal string (or a number), bool as a boolean, address/ID as a hex string. Each returns `null`
// for a missing or mistyped value, so a parser can fail closed instead of inventing a default.

/** A Move struct's fields, from a core `json` value. */
export type Fields = Record<string, unknown>

const MAX_U64 = (1n << 64n) - 1n

/**
 * Unwrap a Move-struct field bag from a core `json` value. The gRPC/core API returns struct
 * fields flat; the old JSON-RPC shape nested them under `.fields`. Tolerate both so parsing is
 * robust to the transport and to the SDK's documented caveat that the `json` shape may vary.
 */
export function structFields(v: unknown): Fields | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Fields
  const nested = o.fields
  return nested && typeof nested === 'object' ? (nested as Fields) : o
}

/** A u64 rendered as a decimal string, a safe integer or a bigint; `null` otherwise. */
export function u64Field(v: unknown): bigint | null {
  let n: bigint
  if (typeof v === 'bigint') n = v
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v)
  else if (typeof v === 'string' && /^\d{1,20}$/.test(v)) n = BigInt(v)
  else return null
  return n >= 0n && n <= MAX_U64 ? n : null
}

/** A bool; `null` unless it is a boolean. */
export function boolField(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null
}

/** A string; `null` unless it is one. */
export function stringField(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** An address or object ID, normalised to `0x` + 64 hex digits; `null` unless it is one. */
export function idField(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const id = normalizeSuiAddress(v)
  return isValidSuiAddress(id) ? id : null
}
