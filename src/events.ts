/**
 * @file Typed `access_gate` events: BCS decoding, full-node listing, and the indexer reader (with its freshness and size checks).
 *
 * Role: the event side of the client. An event is decoded from its BCS bytes, which are exact on every transport, and checked against the package's
 * original id, so a look-alike event from another package is never returned. Listings read the read-indexer first (display data only, never
 * authorisation) and fall back to a full node, which is the source of truth.
 *
 * Main exports: `listAccessGateEvents` (the listing), `EventHistoryPrunedError` and `asPrunedHistoryError` (a full node that no longer keeps the history asked for), `parseAccessGateEvent`, `accessGateEventType`, `readIndexerEvents` (also used by
 * sealed-storage-client), `STALE_AFTER_MS`, `CLOCK_SKEW_TOLERANCE_MS`. Tested in `tests/events.test.ts`; the layouts are pinned against the Move
 * package by `tests/schema.test.ts` and the live drift test.
 */
// `bcs` describes the layouts; `fromBase64` decodes an indexer row's bytes; `normalizeSuiAddress` makes ids comparable.
import { bcs } from '@mysten/sui/bcs'
import { fromBase64, normalizeSuiAddress } from '@mysten/sui/utils'
import type {
  AccessGateEvent,
  AccessGateEventKind,
  CommissionTerms,
  CoreEventEntry,
  EventsClient,
  GatePolicy,
} from './types.js'
import { ACCESS_GATE_MODULE, accessGateType, normalizeType } from './typeNames.js'
import type { AccessGateEventStruct } from './typeNames.js'

// Events are decoded from their BCS bytes, which are exact on every transport (the `json`
// rendering may vary between them). The layouts mirror the Move structs field for field.

/**
 * The full node no longer keeps the events asked for. A public full node keeps only recent history: once a package's events are older than its retention, `listEvents` does not
 * answer with an empty page, it rejects ("requested data below earliest available"). That is a fact about the node, not a fault of this client or of the chain, and an empty list would hide
 * that history exists, so it is reported as its own error. The read-indexer holds the history; a caller shows `message` (written for a person) and may offer to read from the indexer.
 * The node's original error is `cause`.
 */
export class EventHistoryPrunedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super('The network node no longer keeps events this old. Older history needs the event index.', options)
    // The name a log or a caller can test for.
    this.name = 'EventHistoryPrunedError'
  }
}

/** True if `error` is the node saying the range asked for has been pruned (its own wording), or is already an `EventHistoryPrunedError`. */
export function isEventHistoryPruned(error: unknown): boolean {
  if (error instanceof EventHistoryPrunedError) return true
  // The node's own wording, carried in the message of the gRPC error.
  return error instanceof Error && /below earliest available/i.test(error.message)
}

/**
 * Turns the node's "history pruned" rejection into an `EventHistoryPrunedError` (keeping the original as its `cause`); any other error is returned as it is. For use as
 * `throw asPrunedHistoryError(e)` around a `listEvents` call; sealed-storage-client uses it for its own listing.
 */
export function asPrunedHistoryError(error: unknown): unknown {
  if (error instanceof EventHistoryPrunedError) return error
  return isEventHistoryPruned(error) ? new EventHistoryPrunedError({ cause: error }) : error
}

/** The BCS layout of `GatePolicy`: four booleans, in the Move struct's order. */
const Policy = bcs.struct('GatePolicy', {
  freeze_requires_unpaused: bcs.bool(),
  lock_commission_on_freeze: bcs.bool(),
  pause_blocks_decryption: bcs.bool(),
  pause_blocks_access: bcs.bool(),
})
/** The BCS layout of `CommissionTerms`. */
const Terms = bcs.struct('CommissionTerms', { bps: bcs.u64(), min_mist: bcs.u64() })

/**
 * The BCS layout of every event, field for field as the Move structs declare them (the order is the encoding). If the contract adds or reorders a
 * field, `parseAccessGateEvent` fails its strict re-encode check instead of silently dropping the new field.
 */
const LAYOUTS = {
  GateCreatedEvent: bcs.struct('GateCreatedEvent', {
    gate_id: bcs.Address,
    admin_cap_id: bcs.Address,
    price_mist: bcs.u64(),
    default_uses: bcs.u64(),
    soulbound: bcs.bool(),
    auto_burn_at_zero: bcs.bool(),
    nft_name: bcs.string(),
    policy: Policy,
    free_gate_fee_paid_mist: bcs.u64(),
    creator: bcs.Address,
    timestamp_ms: bcs.u64(),
  }),
  AccessMintedEvent: bcs.struct('AccessMintedEvent', {
    nft_id: bcs.Address,
    gate_id: bcs.Address,
    soulbound: bcs.bool(),
    initial_uses: bcs.u64(),
    recipient: bcs.Address,
    commission_mist: bcs.u64(),
    timestamp_ms: bcs.u64(),
  }),
  AccessConsumedEvent: bcs.struct('AccessConsumedEvent', {
    nft_id: bcs.Address,
    gate_id: bcs.Address,
    // The challenge nonce, a `vector<u8>`.
    nonce: bcs.vector(bcs.u8()),
    consumer: bcs.Address,
    uses_after: bcs.u64(),
    timestamp_ms: bcs.u64(),
  }),
  AccessBurnedEvent: bcs.struct('AccessBurnedEvent', {
    nft_id: bcs.Address,
    gate_id: bcs.Address,
    timestamp_ms: bcs.u64(),
  }),
  GateFrozenEvent: bcs.struct('GateFrozenEvent', {
    gate_id: bcs.Address,
    // `Option<CommissionTerms>`: none when the gate follows the live terms.
    locked_commission: bcs.option(Terms),
    timestamp_ms: bcs.u64(),
  }),
  GateMadeFreeEvent: bcs.struct('GateMadeFreeEvent', {
    gate_id: bcs.Address,
    fee_paid_mist: bcs.u64(),
    timestamp_ms: bcs.u64(),
  }),
  PlatformConfigUpdatedEvent: bcs.struct('PlatformConfigUpdatedEvent', {
    treasury: bcs.Address,
    commission_bps: bcs.u64(),
    min_commission_mist: bcs.u64(),
    free_gate_fee_mist: bcs.u64(),
  }),
  PlatformMigratedEvent: bcs.struct('PlatformMigratedEvent', {
    from_version: bcs.u64(),
    to_version: bcs.u64(),
  }),
} as const

/** Event kind ↔ Move struct name. */
const STRUCT_OF: Record<AccessGateEventKind, AccessGateEventStruct> = {
  GateCreated: 'GateCreatedEvent',
  AccessMinted: 'AccessMintedEvent',
  AccessConsumed: 'AccessConsumedEvent',
  AccessBurned: 'AccessBurnedEvent',
  GateFrozen: 'GateFrozenEvent',
  GateMadeFree: 'GateMadeFreeEvent',
  PlatformConfigUpdated: 'PlatformConfigUpdatedEvent',
  PlatformMigrated: 'PlatformMigratedEvent',
}

/** Every event kind, in declaration order. */
export const ACCESS_GATE_EVENT_KINDS = Object.keys(STRUCT_OF) as AccessGateEventKind[]

/** The full event type of `kind` under the package's original id. */
export function accessGateEventType(originalId: string, kind: AccessGateEventKind): string {
  // Events, like types, are defined at the original id.
  return accessGateType(originalId, STRUCT_OF[kind])
}

/** The decoded on-chain policy as the client's camelCase `GatePolicy`. */
function policyOf(p: { [K in keyof typeof Policy.$inferType]: boolean }): GatePolicy {
  return {
    freezeRequiresUnpaused: p.freeze_requires_unpaused,
    lockCommissionOnFreeze: p.lock_commission_on_freeze,
    pauseBlocksDecryption: p.pause_blocks_decryption,
    pauseBlocksAccess: p.pause_blocks_access,
  }
}

/** The decoded `Option<CommissionTerms>` (u64s arrive as decimal strings) as the client's type, or `null` for none. */
function termsOf(t: { bps: string; min_mist: string } | null | undefined): CommissionTerms | null {
  return t ? { bps: BigInt(t.bps), minMist: BigInt(t.min_mist) } : null
}

/**
 * Decode one event, or `null` unless its type is exactly an `access_gate` event of `originalId`
 * (normalised comparison; same-named events of other packages are rejected).
 *
 * @throws {Error} if the BCS bytes do not decode as the event's layout.
 */
export function parseAccessGateEvent(entry: CoreEventEntry, originalId: string): AccessGateEvent | null {
  const type = normalizeType(entry.eventType)
  // The exact prefix `<originalId>::access_gate::`: an event of another package or module never matches.
  const prefix = `${normalizeSuiAddress(originalId)}::${ACCESS_GATE_MODULE}::`
  if (!type?.startsWith(prefix)) return null
  // What follows is the struct name; one we have no layout for (a future event) is not ours to decode.
  const name = type.slice(prefix.length)
  if (!Object.hasOwn(LAYOUTS, name)) return null
  // The indexer serves base64; a full node gives bytes.
  const bytes = typeof entry.bcs === 'string' ? fromBase64(entry.bcs) : entry.bcs
  // `@mysten/bcs` ignores trailing bytes, so a field appended by a later upgrade would decode
  // silently and be lost. A strict decode re-serialises and compares: any difference is drift.
  const layout = LAYOUTS[name as keyof typeof LAYOUTS] as { parse(b: Uint8Array): unknown; serialize(v: never): { toBytes(): Uint8Array } }
  const reencoded = layout.serialize(layout.parse(bytes) as never).toBytes()
  if (reencoded.length !== bytes.length || reencoded.some((b, i) => b !== bytes[i])) {
    throw new Error(`${name} bytes do not match the expected layout (the access_gate event changed?)`)
  }
  // Where the event came from, shared by every variant.
  const origin = {
    txDigest: entry.transactionDigest,
    eventIndex: entry.eventIndex,
    checkpoint: entry.checkpoint,
    sender: normalizeSuiAddress(entry.sender),
  }
  // One case per layout; the object each returns is the client's camelCase type. u64s are BigInt (they decode as strings).
  switch (name as keyof typeof LAYOUTS) {
    case 'GateCreatedEvent': {
      const e = LAYOUTS.GateCreatedEvent.parse(bytes)
      return {
        kind: 'GateCreated',
        ...origin,
        gateId: e.gate_id,
        adminCapId: e.admin_cap_id,
        priceMist: BigInt(e.price_mist),
        defaultUses: BigInt(e.default_uses),
        soulbound: e.soulbound,
        autoBurnAtZero: e.auto_burn_at_zero,
        nftName: e.nft_name,
        policy: policyOf(e.policy),
        freeGateFeePaidMist: BigInt(e.free_gate_fee_paid_mist),
        creator: e.creator,
        timestampMs: BigInt(e.timestamp_ms),
      }
    }
    case 'AccessMintedEvent': {
      const e = LAYOUTS.AccessMintedEvent.parse(bytes)
      return {
        kind: 'AccessMinted',
        ...origin,
        nftId: e.nft_id,
        gateId: e.gate_id,
        soulbound: e.soulbound,
        initialUses: BigInt(e.initial_uses),
        recipient: e.recipient,
        commissionMist: BigInt(e.commission_mist),
        timestampMs: BigInt(e.timestamp_ms),
      }
    }
    case 'AccessConsumedEvent': {
      const e = LAYOUTS.AccessConsumedEvent.parse(bytes)
      return {
        kind: 'AccessConsumed',
        ...origin,
        nftId: e.nft_id,
        gateId: e.gate_id,
        // The decoded `number[]` as bytes.
        nonce: Uint8Array.from(e.nonce),
        consumer: e.consumer,
        usesAfter: BigInt(e.uses_after),
        timestampMs: BigInt(e.timestamp_ms),
      }
    }
    case 'AccessBurnedEvent': {
      const e = LAYOUTS.AccessBurnedEvent.parse(bytes)
      return {
        kind: 'AccessBurned',
        ...origin,
        nftId: e.nft_id,
        gateId: e.gate_id,
        timestampMs: BigInt(e.timestamp_ms),
      }
    }
    case 'GateFrozenEvent': {
      const e = LAYOUTS.GateFrozenEvent.parse(bytes)
      return {
        kind: 'GateFrozen',
        ...origin,
        gateId: e.gate_id,
        lockedCommission: termsOf(e.locked_commission),
        timestampMs: BigInt(e.timestamp_ms),
      }
    }
    case 'GateMadeFreeEvent': {
      const e = LAYOUTS.GateMadeFreeEvent.parse(bytes)
      return {
        kind: 'GateMadeFree',
        ...origin,
        gateId: e.gate_id,
        feePaidMist: BigInt(e.fee_paid_mist),
        timestampMs: BigInt(e.timestamp_ms),
      }
    }
    case 'PlatformConfigUpdatedEvent': {
      const e = LAYOUTS.PlatformConfigUpdatedEvent.parse(bytes)
      return {
        kind: 'PlatformConfigUpdated',
        ...origin,
        treasury: e.treasury,
        commissionBps: BigInt(e.commission_bps),
        minCommissionMist: BigInt(e.min_commission_mist),
        freeGateFeeMist: BigInt(e.free_gate_fee_mist),
      }
    }
    case 'PlatformMigratedEvent': {
      const e = LAYOUTS.PlatformMigratedEvent.parse(bytes)
      return {
        kind: 'PlatformMigrated',
        ...origin,
        fromVersion: BigInt(e.from_version),
        toVersion: BigInt(e.to_version),
      }
    }
  }
}

/** The gate an event concerns, if any (`PlatformConfigUpdated` and `PlatformMigrated` concern none). */
export function eventGateId(event: AccessGateEvent): string | null {
  // Only the gate-scoped variants carry a `gateId`.
  return 'gateId' in event ? event.gateId : null
}

/** A position in an event listing. Cursors from one source are only valid for that source. */
export interface EventCursor {
  /** Which source issued it. */
  source: 'indexer' | 'rpc'
  /** The source's own continuation token. */
  value: string
}

/** A read-indexer to try before the full node. Display data only — never authorisation. */
export interface IndexerSource {
  /** Base URL, e.g. `https://sui-indexer.meddleware.dev`. */
  url: string
  /** The network whose events to read (a path segment of the indexer's API). */
  network: string
  /** Give up and fall back to the full node after this long (default 3000 ms). */
  timeoutMs?: number
  /**
   * A head page (no `before`) whose `polledAt` is older than this is treated as unavailable
   * (default {@link STALE_AFTER_MS}). A value that is not a positive finite number is ignored.
   */
  staleAfterMs?: number
  /** A `fetch` to use instead of the global one (tests, or a runtime with its own). */
  fetch?: typeof fetch
}

/**
 * How old a head page's `polledAt` may be before the indexer counts as unavailable: 4 poll
 * intervals of the indexer's default 15 s. A stuck ingest still answers `200` with frozen data;
 * this is how the client notices.
 */
export const STALE_AFTER_MS = 60_000

/**
 * How far in the future a head page's `polledAt` may be and still count as fresh. The comparison
 * uses the client's own clock, so a client clock that runs behind the indexer's must not make a
 * healthy indexer look broken. A client clock that runs ahead by more than the stale limit
 * makes every head page look stale: the client then reads the full node, which is safe.
 */
export const CLOCK_SKEW_TOLERANCE_MS = 300_000

/** What `listAccessGateEvents` accepts. */
export interface ListAccessGateEventsOptions {
  /** The package's original id: events are matched at it. */
  originalId: string
  /** Event kinds to return (default: all). */
  kinds?: readonly AccessGateEventKind[]
  /** Only events concerning this gate (drops `PlatformConfigUpdated` and `PlatformMigrated`). */
  gateId?: string
  /** Target number of events (default 20, at most 100). */
  limit?: number
  /** Continue from a previous page's `cursor`. */
  cursor?: EventCursor | null
  /** A read-indexer to try first. */
  indexer?: IndexerSource
  /** Full-node pages scanned per call when filtering client-side (default 10). */
  maxPages?: number
}

/** One page of listed events. */
export interface AccessGateEventPage {
  /** Newest first. */
  events: AccessGateEvent[]
  /** Pass back as `cursor` for older events; `null` when there are none. */
  cursor: EventCursor | null
  /** Where this page came from. */
  source: 'indexer' | 'rpc'
  /** Oldest checkpoint the indexer covers (history before it is not listed). Indexer pages only. */
  indexedFromCheckpoint?: string
  /** Why the indexer was skipped, when a first page fell back to the full node. */
  indexerError?: string
  /** Indexer rows skipped because they were malformed or undecodable (display-only data). */
  invalidRows?: number
}

/** Page size the public full nodes cap `listEvents` at. */
const RPC_PAGE = 50
/** How many events a call returns when the caller does not say. */
const DEFAULT_LIMIT = 20
/** The most events one call returns, whatever the caller asks. */
const MAX_LIMIT = 100

/**
 * List `access_gate` events newest first, typed per kind.
 *
 * With `indexer`, a first page is read from it and falls back to the full node if it fails or
 * times out (the reason is in `indexerError`); a cursor stays with the source that issued it.
 * Full-node reads use one filter: the exact event type for a single kind, otherwise the whole
 * `access_gate` module, filtered here. When filtering here, a page can hold more than `limit`
 * events, or fewer when `maxPages` pages are scanned without filling it.
 *
 * @throws {EventHistoryPrunedError} if the full node no longer keeps the history asked for (the indexer, if given, was tried first and `cause` is the node's answer).
 * @throws {Error} if the full node (or, for an indexer cursor, the indexer) fails otherwise.
 */
export async function listAccessGateEvents(
  client: EventsClient,
  options: ListAccessGateEventsOptions,
): Promise<AccessGateEventPage> {
  // Clamp the page size to 1..100 (a fraction or a huge number is not an error).
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
  // De-duplicated; an empty or missing list means every kind.
  const kinds = options.kinds?.length ? [...new Set(options.kinds)] : ACCESS_GATE_EVENT_KINDS
  const { cursor, indexer } = options

  // The indexer is tried first, unless the cursor came from a full node (a cursor stays with its source).
  if (indexer && cursor?.source !== 'rpc') {
    try {
      return await listFromIndexer(indexer, options.originalId, kinds, options.gateId, limit, cursor?.value)
    } catch (e) {
      // A later page has no fallback: the full node cannot continue an indexer cursor.
      if (cursor) throw e
      // A first page falls back to the full node and says why it did.
      const page = await listFromRpc(client, options, kinds, limit, null)
      return { ...page, indexerError: e instanceof Error ? e.message : String(e) }
    }
  }
  // An indexer cursor with no indexer cannot be continued anywhere.
  if (cursor?.source === 'indexer') throw new Error('an indexer cursor needs the indexer option')
  return listFromRpc(client, options, kinds, limit, cursor?.value ?? null)
}

/**
 * List events from a full node. A single kind is filtered by the node (its exact event type); several kinds, or a gate filter, read the whole
 * module and filter here, which is why `maxPages` bounds the scan.
 */
async function listFromRpc(
  client: EventsClient,
  options: ListAccessGateEventsOptions,
  kinds: readonly AccessGateEventKind[],
  limit: number,
  before: string | null,
): Promise<AccessGateEventPage> {
  const { originalId } = options
  // Compare in normalised form, like the parsed events.
  const gateId = options.gateId === undefined ? undefined : normalizeSuiAddress(options.gateId)
  // With exactly one kind the node can do the filtering.
  const only = kinds.length === 1 ? kinds[0] : undefined
  const single = only !== undefined
  // The node's filter: the exact event type for one kind, otherwise every event of the module.
  const eventType = single
    ? accessGateEventType(originalId, only)
    : `${normalizeSuiAddress(originalId)}::${ACCESS_GATE_MODULE}`
  // True when this function discards some of what the node returns, so a page cannot be sized to the limit.
  const filtered = !single || gateId !== undefined
  const wanted = new Set(kinds)
  const maxPages = Math.max(1, options.maxPages ?? 10)

  const events: AccessGateEvent[] = []
  let cursor = before
  // A bounded scan: filtering client-side may need many pages to find `limit` matches.
  for (let page = 0; page < maxPages; page++) {
    // A pruned range is reported as its own error, not as a raw gRPC failure a person would see.
    const res = await client.core
      .listEvents({
        filter: { eventType },
        // Unfiltered: ask for just what is still needed. Filtered: ask for a full page, since many rows will be dropped.
        limit: filtered ? RPC_PAGE : Math.min(RPC_PAGE, limit - events.length),
        order: 'descending',
        before: cursor,
      })
      .catch((e: unknown) => {
        throw asPrunedHistoryError(e)
      })
    for (const entry of res.events) {
      // A full-node row that does not decode throws: that is layout drift, which must not be hidden.
      const event = parseAccessGateEvent(entry, originalId)
      if (event && wanted.has(event.kind) && (gateId === undefined || eventGateId(event) === gateId)) {
        events.push(event)
      }
    }
    // Continue from where the node ended, or stop when it has no more.
    cursor = res.hasNextPage ? res.endCursor : null
    if (!cursor || events.length >= limit) break
  }
  return { events, cursor: cursor ? { source: 'rpc', value: cursor } : null, source: 'rpc' }
}

/** Longest indexer response body read (bytes); a page of 100 events is far below it. */
const MAX_INDEXER_RESPONSE = 1 << 20

/** Read at most {@link MAX_INDEXER_RESPONSE} bytes of `res`, cancelling the stream past the cap. */
async function readCappedText(res: Response): Promise<string> {
  // A declared length over the cap is refused before any body is read (and the stream is released).
  const declared = Number(res.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_INDEXER_RESPONSE) {
    await res.body?.cancel()
    throw new Error('indexer response too large')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  // Read chunk by chunk: the header can be absent or wrong, so the running total is the real limit.
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_INDEXER_RESPONSE) {
      await reader.cancel()
      throw new Error('indexer response too large')
    }
    chunks.push(value)
  }
  // Join the chunks, then decode once (a multi-byte character may span two chunks).
  const bytes = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    bytes.set(c, at)
    at += c.byteLength
  }
  return new TextDecoder().decode(bytes)
}

/** One page of indexer event rows: the full node's events, verbatim (BCS base64). */
export interface IndexerEventsPage {
  /** The rows, as the full node would return them. Untrusted until decoded. */
  events: CoreEventEntry[]
  /** Where the next (older) page starts; `null` at the end. */
  cursor: string | null
  /** Oldest checkpoint the indexer covers. */
  indexedFromCheckpoint?: string
  /** Head pages only: epoch ms of the indexer's last successful poll (already checked for staleness). */
  polledAt?: number
}

/**
 * GET `<indexer.url>/<path>?<params>` within the indexer's timeout and return its event page. The
 * shared reader for every indexer listing (access_gate events here, sealed-content pointers in
 * sealed-storage-client). The rows are untrusted: callers decode and type-check each one like a full-node
 * event.
 *
 * `path` must be relative to the indexer URL (no scheme, no leading `//`), redirects are refused and
 * the body is size-capped while it is read.
 *
 * A head page (no `before` param) must be fresh: its `polledAt` (epoch ms of the indexer's last
 * successful poll) has to be a number no older than `indexer.staleAfterMs` ({@link STALE_AFTER_MS}),
 * judged by this machine's clock; one up to {@link CLOCK_SKEW_TOLERANCE_MS} in the future counts as
 * fresh. Older pages (with `before`) are immutable history and are not checked.
 *
 * @throws {Error} if the URL is not `https:` (`http:` only for a loopback host), `path` leaves the
 *   indexer's origin, the request fails, is redirected or times out, the status is not 2xx, or the body
 *   is oversized, not JSON or not an event page, or a head page is stale (`polledAt` missing, null,
 *   old, or too far in the future).
 */
export async function readIndexerEvents(
  indexer: IndexerSource,
  path: string,
  params: Record<string, string | undefined>,
): Promise<IndexerEventsPage> {
  // A trailing slash makes `new URL(path, base)` append to the base's path instead of replacing its last segment.
  const base = new URL(indexer.url.endsWith('/') ? indexer.url : `${indexer.url}/`)
  // Plain http is allowed only to a machine's own loopback (local development).
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error(`indexer URL must use https: ${indexer.url}`)
  }
  // The path is ours, but a caller could pass one with a scheme, a leading slash or a backslash, any of which can leave the base: refuse.
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || path.startsWith('/') || path.includes('\\')) {
    throw new Error('indexer path must be relative to the indexer URL')
  }
  const url = new URL(path, base)
  // A final check on the resolved URL, whatever the path looked like.
  if (url.origin !== base.origin) throw new Error('indexer path must stay on the indexer origin')
  // Unset parameters are omitted; the values are encoded by `searchParams`.
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value)

  const res = await (indexer.fetch ?? fetch)(url, {
    // A redirect could send the request, and the page, to another host: refuse it.
    redirect: 'error',
    // A cached listing would look fresh while being old.
    cache: 'no-store',
    // The caller falls back to the full node after this long.
    signal: AbortSignal.timeout(indexer.timeoutMs ?? 3000),
  })
  if (!res.ok) {
    await res.body?.cancel()
    throw new Error(`indexer responded ${res.status}`)
  }
  const text = await readCappedText(res)
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('indexer response is not JSON')
  }
  // From here on the body is checked field by field: it is data from another host.
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (!Array.isArray(b.events)) throw new Error('indexer response has no events list')
  const cursor = b.cursor ?? null
  if (cursor !== null && typeof cursor !== 'string') throw new Error('indexer cursor is not a string')
  const from = b.indexedFromCheckpoint
  if (from !== undefined && typeof from !== 'string') throw new Error('indexer checkpoint is not a string')
  // Only a head page is checked for freshness; older pages are history.
  const polledAt = params.before ? undefined : checkFresh(b.polledAt, indexer.staleAfterMs ?? STALE_AFTER_MS)
  return {
    events: b.events as CoreEventEntry[],
    cursor,
    indexedFromCheckpoint: from,
    ...(polledAt === undefined ? {} : { polledAt }),
  }
}

/** The head page's `polledAt` when it is a fresh epoch-ms number; otherwise throws (the indexer counts as unavailable). */
function checkFresh(polledAt: unknown, staleAfterMs: number): number {
  // A bad option (zero, negative, NaN) falls back to the default rather than disabling the check.
  const limit = Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : STALE_AFTER_MS
  // A head page with no timestamp cannot be shown to be fresh.
  if (polledAt === undefined || polledAt === null) throw new Error('indexer is stale: no polledAt on the head page')
  if (typeof polledAt !== 'number' || !Number.isSafeInteger(polledAt) || polledAt <= 0) {
    throw new Error('indexer polledAt is not an epoch-ms number')
  }
  // Positive: the poll is in the past (the normal case).
  const age = Date.now() - polledAt
  if (age > limit) throw new Error(`indexer is stale: last poll ${Math.round(age / 1000)} s ago`)
  // Negative: the poll is in the future by this much; a little is clock skew, a lot is a bad value.
  if (-age > CLOCK_SKEW_TOLERANCE_MS) throw new Error('indexer polledAt is too far in the future')
  return polledAt
}

/** True if `v` has every field of a {@link CoreEventEntry} with the right primitive type. */
function isEventRow(v: unknown): v is CoreEventEntry {
  if (!v || typeof v !== 'object') return false
  const e = v as Record<string, unknown>
  // Every field the decoder reads; `bcs` must be a string here because indexer rows carry base64.
  return (
    typeof e.eventType === 'string' &&
    typeof e.sender === 'string' &&
    typeof e.bcs === 'string' &&
    typeof e.transactionDigest === 'string' &&
    Number.isSafeInteger(e.eventIndex) &&
    (e.checkpoint === null || e.checkpoint === undefined || typeof e.checkpoint === 'string')
  )
}

/** List events from the read-indexer: one request, rows decoded and filtered here (the indexer is display-only, never trusted). */
async function listFromIndexer(
  indexer: IndexerSource,
  originalId: string,
  kinds: readonly AccessGateEventKind[],
  gateId: string | undefined,
  limit: number,
  before: string | undefined,
): Promise<AccessGateEventPage> {
  // The network is a path segment, so it is encoded; the other values are query parameters.
  const body = await readIndexerEvents(indexer, `v1/${encodeURIComponent(indexer.network)}/access-gate/events`, {
    // All kinds is the default and is not sent; a subset is sent sorted so the URL is stable (and cacheable).
    kinds: kinds.length < ACCESS_GATE_EVENT_KINDS.length ? [...kinds].sort().join(',') : undefined,
    gate: gateId === undefined ? undefined : normalizeSuiAddress(gateId),
    before,
    limit: String(limit),
  })

  // The same filters the indexer was asked for, re-applied because its answer is not trusted.
  const wanted = new Set(kinds)
  const gate = gateId === undefined ? undefined : normalizeSuiAddress(gateId)
  const events: AccessGateEvent[] = []
  // How many rows were skipped, reported so a caller can tell a quiet feed from a broken one.
  let invalidRows = 0
  for (const entry of body.events) {
    // The indexer is display-only: rows still have to be this package's events of the asked kinds.
    // A malformed or undecodable row is skipped and counted, so one hostile or buggy row cannot
    // break the feed's pagination (full-node rows keep throwing: that is real layout drift).
    try {
      if (!isEventRow(entry)) throw new Error('malformed row')
      const event = parseAccessGateEvent(entry, originalId)
      if (event && wanted.has(event.kind) && (gate === undefined || eventGateId(event) === gate)) {
        events.push(event)
      }
    } catch {
      invalidRows++
    }
  }
  // The indexer's cursor is wrapped with its source so it cannot be sent to a full node.
  return {
    events,
    cursor: body.cursor ? { source: 'indexer', value: body.cursor } : null,
    source: 'indexer',
    indexedFromCheckpoint: body.indexedFromCheckpoint,
    ...(invalidRows ? { invalidRows } : {}),
  }
}
