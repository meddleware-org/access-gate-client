import { normalizeSuiAddress } from '@mysten/sui/utils'
import type { CoreObject, OwnedAccessNft, OwnedObjectsClient, SuiObjectClient } from './types.js'
import { normalizeAccessNftType, normalizeType } from './typeNames.js'
import { idField, structFields, u64Field } from './json.js'

export { structFields } from './json.js'

/** Upper bound on owned-object pages read by one query (50 objects per page on public nodes). */
export const MAX_OWNED_PAGES = 100

/** The core object in a `getObject` result (`{ object }`) or a bare `listOwnedObjects` item. */
export function coreObject(entry: unknown): CoreObject | undefined {
  if (!entry || typeof entry !== 'object') return undefined
  const e = entry as { object?: CoreObject }
  return e.object ?? (entry as CoreObject)
}

/**
 * Every object of `type` owned by `owner`, across all pages. With `stop`, reading ends at the
 * first page containing an object for which it returns true (for existence checks).
 *
 * @throws {Error} if the RPC call fails, or if more than {@link MAX_OWNED_PAGES} pages would be
 * needed (never a silently truncated list).
 */
export async function listAllOwnedObjects(
  client: OwnedObjectsClient,
  owner: string,
  type: string,
  stop?: (obj: CoreObject) => boolean,
): Promise<CoreObject[]> {
  const all: CoreObject[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_OWNED_PAGES; page++) {
    const res: Awaited<ReturnType<OwnedObjectsClient['core']['listOwnedObjects']>> =
      await client.core.listOwnedObjects({ owner, type, cursor, include: { json: true } })
    const objects = res.objects ?? []
    all.push(...objects)
    if (stop && objects.some(stop)) return all
    if (!res.hasNextPage || !res.cursor) return all
    cursor = res.cursor
  }
  throw new Error(`more than ${MAX_OWNED_PAGES} pages of ${type} owned by ${owner}`)
}

/**
 * Extract `uses_remaining` from a Move enum `AccessVariant` as rendered by RPC, driven by the
 * enum **variant tag** (typed) rather than guessing from field presence. Sui renders a Move
 * enum as `{ variant: 'SingleUse' | 'UnlimitedPass', fields: {...} }`. Returns `null` for an
 * unlimited pass; the remaining count for a single-use.
 */
function parseUsesRemaining(variant: unknown): number | null {
  if (!variant || typeof variant !== 'object') return null
  const v = variant as Record<string, unknown>
  const tag = v.variant ?? v.type ?? v.$kind
  if (tag === 'UnlimitedPass') return null
  const fields = structFields(v)
  const ur = fields?.uses_remaining ?? structFields(fields?.SingleUse)?.uses_remaining
  if (ur != null) return usesToNumber(ur)
  // Either an unknown tag, or a SingleUse whose count is missing from this node's rendering — in
  // both cases the remaining count is unknown, so report null (never a fabricated 0).
  return null
}

/**
 * Convert an on-chain u64 count (rendered as a decimal string or number) exactly. Counts above
 * `Number.MAX_SAFE_INTEGER` saturate there: still "effectively unlimited", and never reported lower
 * than the chain holds. A malformed value is unknown (`null`).
 */
function usesToNumber(raw: unknown): number | null {
  const v = u64Field(raw)
  if (v === null) return null
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(v)
}

/**
 * Parse a core-API object (a `listOwnedObjects` item or a `getObject`'s `{ object }`) into an
 * {@link OwnedAccessNft}, or `null` unless its type is exactly `nftType` (normalised comparison;
 * a same-named struct from another package is rejected).
 *
 * @throws {Error} if `nftType` is not an access_gate NFT type.
 */
export function parseOwnedAccessNft(entry: unknown, nftType: string): OwnedAccessNft | null {
  const expected = normalizeAccessNftType(nftType)
  const obj = coreObject(entry)
  if (!obj?.objectId || normalizeType(obj.type) !== expected) return null
  const inner = structFields(structFields(obj.json)?.data)
  const gateId = idField(inner?.gate_id ?? inner?.gateId)
  const objectId = idField(obj.objectId)
  if (!gateId || !objectId) return null
  return { objectId, gateId, usesRemaining: parseUsesRemaining(inner?.variant) }
}

/**
 * Read one access NFT by id, when a UI needs its exact `usesRemaining`. Returns `null` if the
 * object is not of `nftType`.
 *
 * @throws {Error} if the RPC call fails (including a missing object).
 */
export async function fetchAccessNftById(
  client: SuiObjectClient,
  objectId: string,
  nftType: string,
): Promise<OwnedAccessNft | null> {
  const res = await client.core.getObject({ objectId, include: { json: true } })
  return parseOwnedAccessNft(res, nftType)
}

/**
 * Every access NFT of `nftType` owned by `owner` (all pages), optionally only those of `gateId`.
 *
 * @throws {Error} if an RPC call fails or the owner holds more than {@link MAX_OWNED_PAGES} pages.
 */
export async function fetchAccessNfts(
  client: OwnedObjectsClient,
  owner: string,
  nftType: string,
  gateId?: string,
): Promise<OwnedAccessNft[]> {
  const objects = await listAllOwnedObjects(client, owner, normalizeAccessNftType(nftType))
  const parsed = objects
    .map((o) => parseOwnedAccessNft(o, nftType))
    .filter((n): n is OwnedAccessNft => n !== null)
  const gate = gateId ? normalizeSuiAddress(gateId) : undefined
  return gate ? parsed.filter((n) => n.gateId === gate) : parsed
}

/**
 * True if `owner` holds at least one access NFT of `nftType` (optionally for `gateId`). Stops
 * paging at the first match.
 *
 * @throws {Error} if an RPC call fails.
 */
export async function ownsAccessNft(
  client: OwnedObjectsClient,
  owner: string,
  nftType: string,
  gateId?: string,
): Promise<boolean> {
  const gate = gateId ? normalizeSuiAddress(gateId) : undefined
  const matches = (o: CoreObject): boolean => {
    const nft = parseOwnedAccessNft(o, nftType)
    return nft !== null && (!gate || nft.gateId === gate)
  }
  const objects = await listAllOwnedObjects(client, owner, normalizeAccessNftType(nftType), matches)
  return objects.some(matches)
}
