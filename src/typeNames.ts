import { normalizeStructTag, normalizeSuiAddress, parseStructTag } from '@mysten/sui/utils'

/** The Move module every `access_gate` type lives in. */
export const ACCESS_GATE_MODULE = 'access_gate'

/** Objects defined by `access_gate`. */
export type AccessGateStruct =
  | 'Gate'
  | 'AdminCap'
  | 'PlatformConfig'
  | 'PlatformAdminCap'
  | 'AccessNFT'
  | 'SoulboundAccessNFT'

/** Events emitted by `access_gate`. */
export type AccessGateEventStruct =
  | 'GateCreatedEvent'
  | 'AccessMintedEvent'
  | 'AccessConsumedEvent'
  | 'AccessBurnedEvent'
  | 'GateFrozenEvent'
  | 'GateMadeFreeEvent'
  | 'PlatformConfigUpdatedEvent'

/**
 * The full type `<originalId>::access_gate::<name>`, with the address normalised to 64 hex digits.
 * Types are defined at the package's **original id**; call targets use the latest published-at.
 */
export function accessGateType(originalId: string, name: AccessGateStruct | AccessGateEventStruct): string {
  return `${normalizeSuiAddress(originalId)}::${ACCESS_GATE_MODULE}::${name}`
}

/** The access NFT type a gate mints: `SoulboundAccessNFT` when `soulbound`, else `AccessNFT`. */
export function accessNftType(originalId: string, soulbound: boolean): string {
  return accessGateType(originalId, soulbound ? 'SoulboundAccessNFT' : 'AccessNFT')
}

/** `type` normalised, or `null` if it is not a valid struct tag. */
export function normalizeType(type: unknown): string | null {
  if (typeof type !== 'string') return null
  try {
    return normalizeStructTag(type)
  } catch {
    return null
  }
}

/**
 * True if `type` is exactly `<originalId>::access_gate::<name>` — addresses compared in normalised
 * form, no suffix matching. A same-named struct in another package does not match.
 */
export function isAccessGateType(
  type: unknown,
  originalId: string,
  name: AccessGateStruct | AccessGateEventStruct,
): boolean {
  const normalized = normalizeType(type)
  return normalized !== null && normalized === accessGateType(originalId, name)
}

/**
 * Validate an access NFT type string (`<pkg>::access_gate::AccessNFT` or `…::SoulboundAccessNFT`)
 * and return it normalised.
 *
 * @throws {Error} if `nftType` is not an access_gate NFT type.
 */
export function normalizeAccessNftType(nftType: string): string {
  const normalized = normalizeType(nftType)
  const tag = normalized ? parseStructTag(normalized) : null
  if (
    !normalized ||
    !tag ||
    tag.module !== ACCESS_GATE_MODULE ||
    (tag.name !== 'AccessNFT' && tag.name !== 'SoulboundAccessNFT') ||
    tag.typeParams.length > 0
  ) {
    throw new Error(`not an access_gate NFT type: ${nftType}`)
  }
  return normalized
}
