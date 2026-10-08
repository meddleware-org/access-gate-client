// Rendering of Move types as the chain reports them, in the compact form used by tests/schema.ts and
// tests/abi-table.ts (`$PKG`, `Coin<SUI>`, `String`, …). Shared by the live drift checks.
import { normalizeStructTag } from '@mysten/sui/utils'

const PRIMITIVE: Record<number, string> = { 1: 'address', 2: 'bool', 3: 'u8', 4: 'u16', 5: 'u32', 6: 'u64', 7: 'u128', 8: 'u256' }

function shortName(typeName: string, originalId: string): string {
  const full = normalizeStructTag(typeName)
  const own = `${normalizeStructTag(`${originalId}::x::x`).split('::')[0]}::`
  return full.startsWith(own) ? `$PKG::${full.slice(own.length)}` : full.replace(/^0x0+([1-9a-f])::/, '0x$1::')
}

interface FieldType {
  type?: number | string
  typeName?: string
  typeParameterInstantiation?: FieldType[]
}

/** A struct field type from `getPackage` (numeric `type` enum), as `tests/schema.ts` writes it. */
export function fieldType(t: FieldType, originalId: string): string {
  const k = Number(t.type)
  if (PRIMITIVE[k]) return PRIMITIVE[k]
  if (k === 9) return `vector<${fieldType(t.typeParameterInstantiation?.[0] ?? {}, originalId)}>`
  if (k === 10) {
    const inner = (t.typeParameterInstantiation ?? []).map((x) => fieldType(x, originalId))
    return shortName(t.typeName ?? '', originalId) + (inner.length ? `<${inner.join(',')}>` : '')
  }
  throw new Error(`unknown field type ${JSON.stringify(t)}`)
}

interface OpenSignature {
  reference?: string | number
  body: { $kind: string; datatype?: { typeName: string; typeParameters?: OpenSignature['body'][] }; vector?: OpenSignature['body'] }
}

function bodyType(b: OpenSignature['body'], originalId: string): string {
  if (b.$kind === 'datatype' && b.datatype) {
    const full = normalizeStructTag(b.datatype.typeName)
    if (full === normalizeStructTag('0x1::string::String')) return 'String'
    if (full === normalizeStructTag('0x2::sui::SUI')) return 'SUI'
    const own = `${normalizeStructTag(`${originalId}::x::x`).split('::')[0]}::access_gate::`
    if (full.startsWith(own)) return full.slice(own.length)
    const params = (b.datatype.typeParameters ?? []).map((p) => bodyType(p, originalId))
    if (full === normalizeStructTag('0x2::coin::Coin') && params[0] === 'SUI') return 'Coin<SUI>'
    return full + (params.length ? `<${params.join(',')}>` : '')
  }
  if (b.$kind === 'vector' && b.vector) return `vector<${bodyType(b.vector, originalId)}>`
  if (b.$kind === 'datatype') return 'datatype'
  return b.$kind
}

/** A function parameter as `EXPECTED_PARAMS` writes it: `&mut Gate`, `u64`, `Coin<SUI>`. */
export function paramType(p: OpenSignature, originalId: string): string {
  const ref = p.reference === 'mutable' || p.reference === 2 ? '&mut ' : p.reference === 'immutable' || p.reference === 1 ? '&' : ''
  const body = bodyType(p.body, originalId)
  return ref + body
}
