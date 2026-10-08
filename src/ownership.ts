import { normalizeSuiAddress } from '@mysten/sui/utils'
import type { CoreObject, OwnedAccessNft, OwnedObjectsClient, PassVariant, SuiObjectClient } from './types.js'
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
 * Read the `AccessVariant` enum as a full node renders it: `{ "@variant": "SingleUse",
 * "uses_remaining": "8" }` or `{ "@variant": "UnlimitedPass" }` (pinned against a real testnet pass by
 * the live integration test). Fails closed: an unknown tag, a missing tag or a count that is not a
 * u64 is `null`, never "unlimited" and never a fabricated 0.
 */
function parseVariant(raw: unknown): PassVariant | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (v['@variant'] === 'UnlimitedPass') return { kind: 'unlimited' }
  if (v['@variant'] === 'SingleUse') {
    const remaining = u64Field(v.uses_remaining)
    return remaining === null ? null : { kind: 'singleUse', remaining }
  }
  return null
}

/** True if the pass can still be used: unlimited, or single-use with uses left. */
export function isUsablePass(nft: Pick<OwnedAccessNft, 'variant'>): boolean {
  return nft.variant.kind === 'unlimited' || nft.variant.remaining > 0n
}

/**
 * Parse a core-API object (a `listOwnedObjects` item or a `getObject`'s `{ object }`) into an
 * {@link OwnedAccessNft}, or `null` unless its type is exactly `nftType` (normalised comparison;
 * a same-named struct from another package is rejected) and its gate id and pass variant parse.
 *
 * @throws {Error} if `nftType` is not an access_gate NFT type.
 */
export function parseOwnedAccessNft(entry: unknown, nftType: string): OwnedAccessNft | null {
  const expected = normalizeAccessNftType(nftType)
  const obj = coreObject(entry)
  if (!obj?.objectId || normalizeType(obj.type) !== expected) return null
  const inner = structFields(structFields(obj.json)?.data)
  const gateId = idField(inner?.gate_id)
  const objectId = idField(obj.objectId)
  const variant = parseVariant(inner?.variant)
  if (!gateId || !objectId || !variant) return null
  return { objectId, gateId, variant }
}

/**
 * Read one access NFT by id, when a UI needs its exact pass variant. Returns `null` if the
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
 * True if `owner` holds at least one access NFT of `nftType` (optionally for `gateId`) that can be
 * used: by default only unlimited passes and single-use passes with uses left count, because this is
 * an authorisation decision (an exhausted pass that `auto_burn_at_zero = false` keeps is a receipt, not
 * access). Pass `{ usable: false }` to count every pass of the type. A pass whose variant cannot be
 * parsed never counts. Stops paging at the first match.
 *
 * @throws {Error} if an RPC call fails.
 */
export async function ownsAccessNft(
  client: OwnedObjectsClient,
  owner: string,
  nftType: string,
  gateId?: string,
  opts: { usable?: boolean } = {},
): Promise<boolean> {
  const gate = gateId ? normalizeSuiAddress(gateId) : undefined
  const usable = opts.usable ?? true
  const matches = (o: CoreObject): boolean => {
    const nft = parseOwnedAccessNft(o, nftType)
    return nft !== null && (!gate || nft.gateId === gate) && (!usable || isUsablePass(nft))
  }
  const objects = await listAllOwnedObjects(client, owner, normalizeAccessNftType(nftType), matches)
  return objects.some(matches)
}
