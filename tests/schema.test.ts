// The parsers must agree with the recorded on-chain shape (tests/schema.ts). Values are encoded from the
// schema by a small encoder that shares nothing with src/events.ts, then read back through the real parser:
// a reordered, retyped, added or removed field fails here (and against the live package in the drift check).
//
// Why a separate encoder: if the test used the production layouts to build its input, a wrong layout would encode and decode consistently and pass.
// This encoder knows only the schema table, so it is an independent witness of what the chain's bytes look like.
import { describe, it, expect } from 'vitest'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { parseAccessGateEvent, accessGateEventType, ACCESS_GATE_EVENT_KINDS } from '../src/events.js'
import type { CoreEventEntry } from '../src/types.js'
import { EVENT_STRUCTS, STRUCT_SCHEMAS } from './schema.js'

/** The package id the events are attributed to (any id; the test builds the event type from it). */
const PKG = normalizeSuiAddress('0xa1')

/** ULEB128, the length prefix BCS uses for strings and vectors. */
const uleb = (n: number): number[] => {
  const out: number[] = []
  do {
    let b = n & 0x7f
    n >>>= 7
    if (n) b |= 0x80
    out.push(b)
  } while (n)
  return out
}
/** A u64 as 8 little-endian bytes, as BCS writes it. */
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn))

// A running counter so every u64 and id gets a different value: a parser that swapped two fields would then fail the comparison.
let counter = 0n
/** Encode a deterministic value of Move type `type`; returns bytes and a comparable rendering. */
function encode(type: string): { bytes: number[]; value: unknown } {
  // Each branch is one Move type: its BCS bytes, and the value the parser should give back.
  if (type === 'bool') return { bytes: [1], value: true }
  if (type === 'u64') {
    counter += 1n
    return { bytes: u64le(counter), value: counter }
  }
  if (type === 'address' || type === '0x2::object::ID') {
    counter += 1n
    const hex = counter.toString(16).padStart(64, '0')
    return { bytes: Array.from(Buffer.from(hex, 'hex')), value: `0x${hex}` }
  }
  if (type === '0x1::string::String') return { bytes: [...uleb(3), 0x78, 0x79, 0x7a], value: 'xyz' }
  if (type === 'vector<u8>') return { bytes: [...uleb(3), 1, 2, 3], value: Uint8Array.from([1, 2, 3]) }
  // `Option<T>`: a 1 byte (some) and then the value.
  let m = type.match(/^0x1::option::Option<(.+)>$/)
  if (m) {
    const inner = encode(m[1]!)
    return { bytes: [1, ...inner.bytes], value: inner.value }
  }
  // A struct of this package: its fields, concatenated in declaration order.
  m = type.match(/^\$PKG::access_gate::(\w+)$/)
  if (m) {
    const name = m[1]!
    const fields = STRUCT_SCHEMAS[name]
    if (!fields) throw new Error(`no schema for ${name}`)
    const parts = fields.map(([, t]) => encode(t))
    return { bytes: parts.flatMap((p) => p.bytes), value: Object.fromEntries(fields.map(([n], i) => [n, parts[i]!.value])) }
  }
  // A type the encoder does not know means the schema grew; extend the encoder rather than skip the field.
  throw new Error(`the test encoder does not know ${type}`)
}

/** snake_case (Move) to camelCase (the client's types). */
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
// Where the TypeScript field is named differently from the Move field.
const RENAMES: Record<string, string> = { free_gate_fee_paid_mist: 'freeGateFeePaidMist' }

describe('event parsers match the recorded on-chain schema', () => {
  // The schema and the parser's kinds must be the same set, or an event kind would go untested.
  it('covers every parsed event kind', () => {
    expect(EVENT_STRUCTS.length).toBe(ACCESS_GATE_EVENT_KINDS.length)
  })

  for (const struct of EVENT_STRUCTS) {
    it(`${struct}: a value encoded from the schema decodes field by field`, () => {
      const fields = STRUCT_SCHEMAS[struct]!
      // Encode a value for each field in order; the concatenated bytes are the event's BCS.
      const encoded = fields.map(([, type]) => encode(type))
      // The kind whose Move struct this is.
      const kind = ACCESS_GATE_EVENT_KINDS.find((k) => accessGateEventType(PKG, k).endsWith(`::${struct}`))
      expect(kind, struct).toBeDefined()
      const entry: CoreEventEntry = {
        eventType: accessGateEventType(PKG, kind!),
        bcs: toBase64(Uint8Array.from(encoded.flatMap((e) => e.bytes))),
        transactionDigest: 'D'.repeat(44),
        eventIndex: 0,
        checkpoint: '1',
        sender: '0x1',
        // The cast: the real type's `bcs` is bytes or base64; the helper builds the base64 form an indexer serves.
      } as unknown as CoreEventEntry
      const parsed = parseAccessGateEvent(entry, PKG) as unknown as Record<string, unknown>
      expect(parsed, struct).not.toBeNull()
      fields.forEach(([name, type], i) => {
        const key = RENAMES[name] ?? camel(name)
        // Nested structs and options have a different shape in the client's type; the policy and terms are covered by the events tests.
        if (type.startsWith('$PKG::') || type.startsWith('0x1::option')) return
        const want = encoded[i]!.value
        const got = parsed[key]
        if (want instanceof Uint8Array) expect([...(got as Uint8Array)], `${struct}.${name}`).toEqual([...want])
        else expect(got, `${struct}.${name}`).toEqual(want)
      })
    })

    // `@mysten/bcs` ignores trailing bytes by itself; the parser's strict re-encode check is what turns a field added by an upgrade into an error.
    it(`${struct}: a trailing byte (a field appended by an upgrade) is refused, not dropped`, () => {
      const fields = STRUCT_SCHEMAS[struct]!
      const bytes = fields.flatMap(([, t]) => encode(t).bytes).concat([0])
      const kind = ACCESS_GATE_EVENT_KINDS.find((k) => accessGateEventType(PKG, k).endsWith(`::${struct}`))!
      const entry = {
        eventType: accessGateEventType(PKG, kind),
        bcs: toBase64(Uint8Array.from(bytes)),
        transactionDigest: 'D'.repeat(44),
        eventIndex: 0,
        checkpoint: '1',
        sender: '0x1',
      } as unknown as CoreEventEntry
      expect(() => parseAccessGateEvent(entry, PKG)).toThrow(/do not match the expected layout/)
    })
  }
})
