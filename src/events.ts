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

const Policy = bcs.struct('GatePolicy', {
  freeze_requires_unpaused: bcs.bool(),
  lock_commission_on_freeze: bcs.bool(),
  pause_blocks_decryption: bcs.bool(),
  pause_blocks_access: bcs.bool(),
})
const Terms = bcs.struct('CommissionTerms', { bps: bcs.u64(), min_mist: bcs.u64() })

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
  return accessGateType(originalId, STRUCT_OF[kind])
}

function policyOf(p: { [K in keyof typeof Policy.$inferType]: boolean }): GatePolicy {
  return {
    freezeRequiresUnpaused: p.freeze_requires_unpaused,
    lockCommissionOnFreeze: p.lock_commission_on_freeze,
    pauseBlocksDecryption: p.pause_blocks_decryption,
    pauseBlocksAccess: p.pause_blocks_access,
  }
}

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
  const prefix = `${normalizeSuiAddress(originalId)}::${ACCESS_GATE_MODULE}::`
  if (!type?.startsWith(prefix)) return null
  const name = type.slice(prefix.length)
  if (!Object.hasOwn(LAYOUTS, name)) return null
  const bytes = typeof entry.bcs === 'string' ? fromBase64(entry.bcs) : entry.bcs
  const origin = {
    txDigest: entry.transactionDigest,
    eventIndex: entry.eventIndex,
    checkpoint: entry.checkpoint,
    sender: normalizeSuiAddress(entry.sender),
  }
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
  return 'gateId' in event ? event.gateId : null
}

/** A position in an event listing. Cursors from one source are only valid for that source. */
export interface EventCursor {
  source: 'indexer' | 'rpc'
  value: string
}

/** A read-indexer to try before the full node. Display data only — never authorisation. */
export interface IndexerSource {
  /** Base URL, e.g. `https://sui-indexer.meddleware.co.uk`. */
  url: string
  network: string
  /** Give up and fall back to the full node after this long (default 3000 ms). */
  timeoutMs?: number
  fetch?: typeof fetch
}

export interface ListAccessGateEventsOptions {
  originalId: string
  /** Event kinds to return (default: all). */
  kinds?: readonly AccessGateEventKind[]
  /** Only events concerning this gate (drops `PlatformConfigUpdated` and `PlatformMigrated`). */
  gateId?: string
  /** Target number of events (default 20, at most 100). */
  limit?: number
  /** Continue from a previous page's `cursor`. */
  cursor?: EventCursor | null
  indexer?: IndexerSource
  /** Full-node pages scanned per call when filtering client-side (default 10). */
  maxPages?: number
}

export interface AccessGateEventPage {
  /** Newest first. */
  events: AccessGateEvent[]
  /** Pass back as `cursor` for older events; `null` when there are none. */
  cursor: EventCursor | null
  source: 'indexer' | 'rpc'
  /** Oldest checkpoint the indexer covers (history before it is not listed). Indexer pages only. */
  indexedFromCheckpoint?: string
  /** Why the indexer was skipped, when a first page fell back to the full node. */
  indexerError?: string
}

/** Page size the public full nodes cap `listEvents` at. */
const RPC_PAGE = 50
const DEFAULT_LIMIT = 20
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
 * @throws {Error} if the full node (or, for an indexer cursor, the indexer) fails.
 */
export async function listAccessGateEvents(
  client: EventsClient,
  options: ListAccessGateEventsOptions,
): Promise<AccessGateEventPage> {
  const limit = Math.min(Math.max(1, Math.floor(options.limit ?? DEFAULT_LIMIT)), MAX_LIMIT)
  const kinds = options.kinds?.length ? [...new Set(options.kinds)] : ACCESS_GATE_EVENT_KINDS
  const { cursor, indexer } = options

  if (indexer && cursor?.source !== 'rpc') {
    try {
      return await listFromIndexer(indexer, options.originalId, kinds, options.gateId, limit, cursor?.value)
    } catch (e) {
      if (cursor) throw e
      const page = await listFromRpc(client, options, kinds, limit, null)
      return { ...page, indexerError: e instanceof Error ? e.message : String(e) }
    }
  }
  if (cursor?.source === 'indexer') throw new Error('an indexer cursor needs the indexer option')
  return listFromRpc(client, options, kinds, limit, cursor?.value ?? null)
}

async function listFromRpc(
  client: EventsClient,
  options: ListAccessGateEventsOptions,
  kinds: readonly AccessGateEventKind[],
  limit: number,
  before: string | null,
): Promise<AccessGateEventPage> {
  const { originalId } = options
  const gateId = options.gateId === undefined ? undefined : normalizeSuiAddress(options.gateId)
  const only = kinds.length === 1 ? kinds[0] : undefined
  const single = only !== undefined
  const eventType = single
    ? accessGateEventType(originalId, only)
    : `${normalizeSuiAddress(originalId)}::${ACCESS_GATE_MODULE}`
  const filtered = !single || gateId !== undefined
  const wanted = new Set(kinds)
  const maxPages = Math.max(1, options.maxPages ?? 10)

  const events: AccessGateEvent[] = []
  let cursor = before
  for (let page = 0; page < maxPages; page++) {
    const res = await client.core.listEvents({
      filter: { eventType },
      limit: filtered ? RPC_PAGE : Math.min(RPC_PAGE, limit - events.length),
      order: 'descending',
      before: cursor,
    })
    for (const entry of res.events) {
      const event = parseAccessGateEvent(entry, originalId)
      if (event && wanted.has(event.kind) && (gateId === undefined || eventGateId(event) === gateId)) {
        events.push(event)
      }
    }
    cursor = res.hasNextPage ? res.endCursor : null
    if (!cursor || events.length >= limit) break
  }
  return { events, cursor: cursor ? { source: 'rpc', value: cursor } : null, source: 'rpc' }
}

/** Longest indexer response body read (characters); a page of 100 events is far below it. */
const MAX_INDEXER_RESPONSE = 1 << 20

/** One page of indexer event rows: the full node's events, verbatim (BCS base64). */
export interface IndexerEventsPage {
  events: CoreEventEntry[]
  cursor: string | null
  /** Oldest checkpoint the indexer covers. */
  indexedFromCheckpoint?: string
}

/**
 * GET `<indexer.url>/<path>?<params>` within the indexer's timeout and return its event page. The
 * shared reader for every indexer listing (access_gate events here, sealed-content pointers in
 * seal-client). The rows are untrusted: callers decode and type-check each one like a full-node
 * event.
 *
 * @throws {Error} if the URL is not `https:` (`http:` only for a loopback host), the request fails
 *   or times out, the status is not 2xx, or the body is oversized, not JSON or not an event page.
 */
export async function readIndexerEvents(
  indexer: IndexerSource,
  path: string,
  params: Record<string, string | undefined>,
): Promise<IndexerEventsPage> {
  const base = new URL(indexer.url.endsWith('/') ? indexer.url : `${indexer.url}/`)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) {
    throw new Error(`indexer URL must use https: ${indexer.url}`)
  }
  const url = new URL(path, base)
  for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, value)

  const res = await (indexer.fetch ?? fetch)(url, { signal: AbortSignal.timeout(indexer.timeoutMs ?? 3000) })
  if (!res.ok) throw new Error(`indexer responded ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_INDEXER_RESPONSE) throw new Error('indexer response too large')
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('indexer response is not JSON')
  }
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  if (!Array.isArray(b.events)) throw new Error('indexer response has no events list')
  const cursor = b.cursor ?? null
  if (cursor !== null && typeof cursor !== 'string') throw new Error('indexer cursor is not a string')
  const from = b.indexedFromCheckpoint
  if (from !== undefined && typeof from !== 'string') throw new Error('indexer checkpoint is not a string')
  return { events: b.events as CoreEventEntry[], cursor, indexedFromCheckpoint: from }
}

async function listFromIndexer(
  indexer: IndexerSource,
  originalId: string,
  kinds: readonly AccessGateEventKind[],
  gateId: string | undefined,
  limit: number,
  before: string | undefined,
): Promise<AccessGateEventPage> {
  const body = await readIndexerEvents(indexer, `v1/${encodeURIComponent(indexer.network)}/access-gate/events`, {
    kinds: kinds.length < ACCESS_GATE_EVENT_KINDS.length ? [...kinds].sort().join(',') : undefined,
    gate: gateId === undefined ? undefined : normalizeSuiAddress(gateId),
    before,
    limit: String(limit),
  })

  const wanted = new Set(kinds)
  const gate = gateId === undefined ? undefined : normalizeSuiAddress(gateId)
  const events: AccessGateEvent[] = []
  for (const entry of body.events) {
    // The indexer is display-only: rows still have to be this package's events of the asked kinds.
    const event = parseAccessGateEvent(entry, originalId)
    if (event && wanted.has(event.kind) && (gate === undefined || eventGateId(event) === gate)) {
      events.push(event)
    }
  }
  return {
    events,
    cursor: body.cursor ? { source: 'indexer', value: body.cursor } : null,
    source: 'indexer',
    indexedFromCheckpoint: body.indexedFromCheckpoint,
  }
}
