/**
 * @file Strict readers for the values a Sui full node renders in an object's `json`.
 *
 * Role: the one place that decides what a u64, a bool, a string or an address looks like on the wire, so `gates.ts`, `ownership.ts` and `events.ts`
 * parse every object the same way and fail closed (`null`) instead of inventing a default. Nothing here touches the network.
 *
 * Main exports: `structFields`, `u64Field`, `boolField`, `stringField`, `idField`. Tested through the parsers' tests (`gates.test.ts`,
 * `ownership.test.ts`, `events.test.ts`) and the schema tests.
 */
// `normalizeSuiAddress` pads an address to 64 hex digits; `isValidSuiAddress` then checks the result is one.
import { isValidSuiAddress, normalizeSuiAddress } from '@mysten/sui/utils'

// Strict readers for Move values as a full node renders them in an object's `json`: u64 as a
// decimal string (or a number), bool as a boolean, address/ID as a hex string. Each returns `null`
// for a missing or mistyped value, so a parser can fail closed instead of inventing a default.

/** A Move struct's fields, from a core `json` value. */
export type Fields = Record<string, unknown>

/** The largest value a Move `u64` holds (2^64 - 1); anything above it is not a u64, whatever it looks like. */
const MAX_U64 = (1n << 64n) - 1n

/**
 * Unwrap a Move-struct field bag from a core `json` value. The gRPC/core API returns struct
 * fields flat; the old JSON-RPC shape nested them under `.fields`. Tolerate both so parsing is
 * robust to the transport and to the SDK's documented caveat that the `json` shape may vary.
 */
export function structFields(v: unknown): Fields | undefined {
  // A struct is an object; a string, number, null or array is not one.
  if (!v || typeof v !== 'object') return undefined
  const o = v as Fields
  // The old JSON-RPC shape wrapped the fields in a `fields` key; the flat gRPC shape has none.
  const nested = o.fields
  return nested && typeof nested === 'object' ? (nested as Fields) : o
}

/** A u64 rendered as a decimal string, a safe integer or a bigint; `null` otherwise. */
export function u64Field(v: unknown): bigint | null {
  let n: bigint
  // A bigint is taken as it is.
  if (typeof v === 'bigint') n = v
  // A number only if it is a safe integer: a float or an unsafe integer has already lost precision.
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v)
  // A decimal string of at most 20 digits (u64's maximum has 20); a sign, a decimal point or a hex prefix is refused.
  else if (typeof v === 'string' && /^\d{1,20}$/.test(v)) n = BigInt(v)
  else return null
  // 20 digits can exceed 2^64 - 1, and a bigint can be negative: the range check is the last gate.
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
  // Normalise first (short forms like `0x2` become 64 digits), then validate the result.
  const id = normalizeSuiAddress(v)
  return isValidSuiAddress(id) ? id : null
}
