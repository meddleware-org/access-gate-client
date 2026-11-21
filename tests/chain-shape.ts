// Rendering of Move types as the chain reports them, in the compact form used by tests/schema.ts and
// tests/abi-table.ts (`$PKG`, `Coin<SUI>`, `String`, …). Shared by the live drift checks.
//
// Why: the node describes a type as a numbered enum plus a name; the expected tables are written in the compact form a person can read. These functions
// translate the first into the second so the drift tests can compare text with text.
import { normalizeStructTag } from '@mysten/sui/utils'

/** The node's numeric type codes for the primitive types (the gRPC `OpenSignatureBody` / field type enum), as their Move names. */
const PRIMITIVE: Record<number, string> = { 1: 'address', 2: 'bool', 3: 'u8', 4: 'u16', 5: 'u32', 6: 'u64', 7: 'u128', 8: 'u256' }

/** A struct type name with this package's id written as `$PKG` and the framework addresses shortened (`0x2::…`). */
function shortName(typeName: string, originalId: string): string {
  const full = normalizeStructTag(typeName)
  // The package's own normalised address plus `::`, which is what to strip.
  const own = `${normalizeStructTag(`${originalId}::x::x`).split('::')[0]}::`
  return full.startsWith(own) ? `$PKG::${full.slice(own.length)}` : full.replace(/^0x0+([1-9a-f])::/, '0x$1::')
}

/** A struct field's type as `getPackage` returns it. */
interface FieldType {
  /** The numeric type code (see `PRIMITIVE`; 9 is a vector, 10 a struct). */
  type?: number | string
  /** The struct's full name, for a struct type. */
  typeName?: string
  /** The type arguments, for a vector or a generic struct. */
  typeParameterInstantiation?: FieldType[]
}

/** A struct field type from `getPackage` (numeric `type` enum), as `tests/schema.ts` writes it. */
export function fieldType(t: FieldType, originalId: string): string {
  const k = Number(t.type)
  if (PRIMITIVE[k]) return PRIMITIVE[k]
  // 9: a vector; its element is the only type argument.
  if (k === 9) return `vector<${fieldType(t.typeParameterInstantiation?.[0] ?? {}, originalId)}>`
  // 10: a struct, possibly generic.
  if (k === 10) {
    const inner = (t.typeParameterInstantiation ?? []).map((x) => fieldType(x, originalId))
    return shortName(t.typeName ?? '', originalId) + (inner.length ? `<${inner.join(',')}>` : '')
  }
  // An unrecognised code means the node's enum changed; fail loudly rather than compare against a guess.
  throw new Error(`unknown field type ${JSON.stringify(t)}`)
}

/** A function parameter's signature as the node returns it: a reference kind and a body. */
interface OpenSignature {
  /** Absent for a value, `immutable` (1) or `mutable` (2) for a reference. */
  reference?: string | number
  /** The type itself. */
  body: { $kind: string; datatype?: { typeName: string; typeParameters?: OpenSignature['body'][] }; vector?: OpenSignature['body'] }
}

/** A parameter's type body in the compact form (`String`, `SUI`, `Gate`, `vector<u8>`, `Coin<SUI>`). */
function bodyType(b: OpenSignature['body'], originalId: string): string {
  if (b.$kind === 'datatype' && b.datatype) {
    const full = normalizeStructTag(b.datatype.typeName)
    // The two framework types the table abbreviates.
    if (full === normalizeStructTag('0x1::string::String')) return 'String'
    if (full === normalizeStructTag('0x2::sui::SUI')) return 'SUI'
    // This package's own types are written without their address.
    const own = `${normalizeStructTag(`${originalId}::x::x`).split('::')[0]}::access_gate::`
    if (full.startsWith(own)) return full.slice(own.length)
    const params = (b.datatype.typeParameters ?? []).map((p) => bodyType(p, originalId))
    // `Coin<SUI>` is the one generic the table abbreviates.
    if (full === normalizeStructTag('0x2::coin::Coin') && params[0] === 'SUI') return 'Coin<SUI>'
    return full + (params.length ? `<${params.join(',')}>` : '')
  }
  if (b.$kind === 'vector' && b.vector) return `vector<${bodyType(b.vector, originalId)}>`
  // A datatype with no detail, or any other kind (a primitive name, a type parameter): the kind's own name.
  if (b.$kind === 'datatype') return 'datatype'
  return b.$kind
}

/** A function parameter as `EXPECTED_PARAMS` writes it: `&mut Gate`, `u64`, `Coin<SUI>`. */
export function paramType(p: OpenSignature, originalId: string): string {
  // The node reports the reference kind as a string or a number depending on the transport.
  const ref = p.reference === 'mutable' || p.reference === 2 ? '&mut ' : p.reference === 'immutable' || p.reference === 1 ? '&' : ''
  const body = bodyType(p.body, originalId)
  return ref + body
}
