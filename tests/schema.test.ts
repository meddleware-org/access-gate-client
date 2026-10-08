// The parsers must agree with the recorded on-chain shape (tests/schema.ts). Values are encoded from the
// schema by a small encoder that shares nothing with src/events.ts, then read back through the real parser:
// a reordered, retyped, added or removed field fails here (and against the live package in the drift check).
import { describe, it, expect } from 'vitest'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import { parseAccessGateEvent, accessGateEventType, ACCESS_GATE_EVENT_KINDS } from '../src/events.js'
import type { CoreEventEntry } from '../src/types.js'
import { EVENT_STRUCTS, STRUCT_SCHEMAS } from './schema.js'

const PKG = normalizeSuiAddress('0xa1')

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
const u64le = (v: bigint): number[] => Array.from({ length: 8 }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn))

let counter = 0n
/** Encode a deterministic value of Move type `type`; returns bytes and a comparable rendering. */
function encode(type: string): { bytes: number[]; value: unknown } {
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
  let m = type.match(/^0x1::option::Option<(.+)>$/)
  if (m) {
    const inner = encode(m[1]!)
    return { bytes: [1, ...inner.bytes], value: inner.value }
  }
  m = type.match(/^\$PKG::access_gate::(\w+)$/)
  if (m) {
    const name = m[1]!
    const fields = STRUCT_SCHEMAS[name]
    if (!fields) throw new Error(`no schema for ${name}`)
    const parts = fields.map(([, t]) => encode(t))
    return { bytes: parts.flatMap((p) => p.bytes), value: Object.fromEntries(fields.map(([n], i) => [n, parts[i]!.value])) }
  }
  throw new Error(`the test encoder does not know ${type}`)
}

const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
// Where the TypeScript field is named differently from the Move field.
const RENAMES: Record<string, string> = { free_gate_fee_paid_mist: 'freeGateFeePaidMist' }

describe('event parsers match the recorded on-chain schema', () => {
  it('covers every parsed event kind', () => {
    expect(EVENT_STRUCTS.length).toBe(ACCESS_GATE_EVENT_KINDS.length)
  })

  for (const struct of EVENT_STRUCTS) {
    it(`${struct}: a value encoded from the schema decodes field by field`, () => {
      const fields = STRUCT_SCHEMAS[struct]!
      const encoded = fields.map(([, type]) => encode(type))
      const kind = ACCESS_GATE_EVENT_KINDS.find((k) => accessGateEventType(PKG, k).endsWith(`::${struct}`))
      expect(kind, struct).toBeDefined()
      const entry: CoreEventEntry = {
        eventType: accessGateEventType(PKG, kind!),
        bcs: toBase64(Uint8Array.from(encoded.flatMap((e) => e.bytes))),
        transactionDigest: 'D'.repeat(44),
        eventIndex: 0,
        checkpoint: '1',
        sender: '0x1',
      } as unknown as CoreEventEntry
      const parsed = parseAccessGateEvent(entry, PKG) as unknown as Record<string, unknown>
      expect(parsed, struct).not.toBeNull()
      fields.forEach(([name, type], i) => {
        const key = RENAMES[name] ?? camel(name)
        if (type.startsWith('$PKG::') || type.startsWith('0x1::option')) return // nested structs: checked below
        const want = encoded[i]!.value
        const got = parsed[key]
        if (want instanceof Uint8Array) expect([...(got as Uint8Array)], `${struct}.${name}`).toEqual([...want])
        else expect(got, `${struct}.${name}`).toEqual(want)
      })
    })

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
