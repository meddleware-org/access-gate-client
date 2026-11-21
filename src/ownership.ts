/**
 * @file Reads of the access NFTs an address owns: paging through owned objects, parsing a pass, and the ownership check an access decision uses.
 *
 * Role: the read side of "does this wallet hold a pass for this gate?". Every function takes the structural client subsets from `types.ts`, so it works
 * with the SDK's gRPC client or a test double. Parsers fail closed: a pass whose type, gate id or variant does not parse is `null` and never counts.
 *
 * Main exports: `ownsAccessNft` (the authorisation check), `fetchAccessNfts`, `fetchAccessNftById`, `parseOwnedAccessNft`, `isUsablePass`,
 * `listAllOwnedObjects`, `MAX_OWNED_PAGES`. Tested in `tests/ownership.test.ts`; the real node shape is pinned by the integration tests.
 */
// Address normalisation, so a gate id passed as `0x2` equals the padded id the node returns.
import { normalizeSuiAddress } from '@mysten/sui/utils'
import type { CoreObject, OwnedAccessNft, OwnedObjectsClient, PassVariant, SuiObjectClient } from './types.js'
import { normalizeAccessNftType, normalizeType } from './typeNames.js'
import { idField, structFields, u64Field } from './json.js'

// Re-exported because the parsers in `gates.ts` and some consumers read struct fields the same way.
export { structFields } from './json.js'

/** Upper bound on owned-object pages read by one query (50 objects per page on public nodes). */
export const MAX_OWNED_PAGES = 100

/** The core object in a `getObject` result (`{ object }`) or a bare `listOwnedObjects` item. */
export function coreObject(entry: unknown): CoreObject | undefined {
  // Not an object at all: nothing to read.
  if (!entry || typeof entry !== 'object') return undefined
  const e = entry as { object?: CoreObject }
  // `getObject` wraps the object as `{ object }`; a list item is the object itself.
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
  // Everything read so far, in page order.
  const all: CoreObject[] = []
  // Where the next page starts; null asks for the first page.
  let cursor: string | null = null
  // A bounded loop: a node that never reports the last page must not trap the caller.
  for (let page = 0; page < MAX_OWNED_PAGES; page++) {
    // The explicit type breaks a circular inference (the loop reads `cursor`, which this call sets).
    const res: Awaited<ReturnType<OwnedObjectsClient['core']['listOwnedObjects']>> =
      await client.core.listOwnedObjects({ owner, type, cursor, include: { json: true } })
    // A node that omits the list is treated as an empty page.
    const objects = res.objects ?? []
    all.push(...objects)
    // An existence check can stop as soon as a page holds a match: the rest would only cost requests.
    if (stop && objects.some(stop)) return all
    // The last page, or no cursor to continue from.
    if (!res.hasNextPage || !res.cursor) return all
    cursor = res.cursor
  }
  // Too many pages: fail loudly rather than return a list that looks complete and is not (an authorisation check would be wrong).
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
  // The unlimited pass carries no count.
  if (v['@variant'] === 'UnlimitedPass') return { kind: 'unlimited' }
  if (v['@variant'] === 'SingleUse') {
    // The count is a u64 rendered as a string; a bad one is a parse failure, not zero.
    const remaining = u64Field(v.uses_remaining)
    return remaining === null ? null : { kind: 'singleUse', remaining }
  }
  // An unknown tag (a future variant, a renamed one) is not claimed.
  return null
}

/** True if the pass can still be used: unlimited, or single-use with uses left. */
export function isUsablePass(nft: Pick<OwnedAccessNft, 'variant'>): boolean {
  // The narrowing on `kind` makes `remaining` available only for a single-use pass.
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
  // Validate the expected type first: a bad `nftType` is the caller's error and throws, whatever the entry is.
  const expected = normalizeAccessNftType(nftType)
  const obj = coreObject(entry)
  // The object's own type must equal it exactly (normalised); this is what rejects a look-alike struct.
  if (!obj?.objectId || normalizeType(obj.type) !== expected) return null
  // The NFT's fields sit one level down, under `data` (a wrapper the Move struct defines).
  const inner = structFields(structFields(obj.json)?.data)
  const gateId = idField(inner?.gate_id)
  const objectId = idField(obj.objectId)
  const variant = parseVariant(inner?.variant)
  // Any missing piece fails the whole parse.
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
  // `include.json` asks the node for the struct's fields, which the parser needs.
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
  // Listing by the normalised type lets the node filter, so only this package's NFTs are paged.
  const objects = await listAllOwnedObjects(client, owner, normalizeAccessNftType(nftType))
  // Objects that fail to parse (wrong type, missing field) are dropped, never returned half-read.
  const parsed = objects
    .map((o) => parseOwnedAccessNft(o, nftType))
    .filter((n): n is OwnedAccessNft => n !== null)
  // Compare in normalised form, since the parsed gate ids are normalised.
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
  // Usable-only is the default because this answers an authorisation question; counting every pass is the caller's explicit choice.
  const usable = opts.usable ?? true
  // One predicate serves both the early stop while paging and the final answer, so they cannot disagree.
  const matches = (o: CoreObject): boolean => {
    const nft = parseOwnedAccessNft(o, nftType)
    return nft !== null && (!gate || nft.gateId === gate) && (!usable || isUsablePass(nft))
  }
  const objects = await listAllOwnedObjects(client, owner, normalizeAccessNftType(nftType), matches)
  // `listAllOwnedObjects` may have returned several pages; any match among them answers yes.
  return objects.some(matches)
}
