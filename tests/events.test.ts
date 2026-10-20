import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { bcs } from '@mysten/sui/bcs'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import {
  ACCESS_GATE_EVENT_KINDS,
  accessGateEventType,
  eventGateId,
  listAccessGateEvents,
  parseAccessGateEvent,
  readIndexerEvents,
  STALE_AFTER_MS,
  CLOCK_SKEW_TOLERANCE_MS,
} from '../src/events.js'
import type { ListAccessGateEventsOptions } from '../src/events.js'
import type { CoreEventEntry, EventsClient } from '../src/types.js'

const PKG = '0xa1'
const PKG_LONG = normalizeSuiAddress(PKG)
const LOOKALIKE = '0xa1a1'
const GATE_A = normalizeSuiAddress('0xa')
const GATE_B = normalizeSuiAddress('0xb')
const NFT = normalizeSuiAddress('0x11')
const ALICE = normalizeSuiAddress('0xa11ce')

// Test-side encoders, written from the Move structs independently of the parser's layouts.
const minted = bcs.struct('AccessMintedEvent', {
  nft_id: bcs.Address,
  gate_id: bcs.Address,
  soulbound: bcs.bool(),
  initial_uses: bcs.u64(),
  recipient: bcs.Address,
  commission_mist: bcs.u64(),
  timestamp_ms: bcs.u64(),
})
const consumed = bcs.struct('AccessConsumedEvent', {
  nft_id: bcs.Address,
  gate_id: bcs.Address,
  nonce: bcs.vector(bcs.u8()),
  consumer: bcs.Address,
  uses_after: bcs.u64(),
  timestamp_ms: bcs.u64(),
})
const frozen = bcs.struct('GateFrozenEvent', {
  gate_id: bcs.Address,
  locked_commission: bcs.option(bcs.struct('CommissionTerms', { bps: bcs.u64(), min_mist: bcs.u64() })),
  timestamp_ms: bcs.u64(),
})
const migrated = bcs.struct('PlatformMigratedEvent', { from_version: bcs.u64(), to_version: bcs.u64() })
const platform = bcs.struct('PlatformConfigUpdatedEvent', {
  treasury: bcs.Address,
  commission_bps: bcs.u64(),
  min_commission_mist: bcs.u64(),
  free_gate_fee_mist: bcs.u64(),
})
const created = bcs.struct('GateCreatedEvent', {
  gate_id: bcs.Address,
  admin_cap_id: bcs.Address,
  price_mist: bcs.u64(),
  default_uses: bcs.u64(),
  soulbound: bcs.bool(),
  auto_burn_at_zero: bcs.bool(),
  nft_name: bcs.string(),
  policy: bcs.struct('GatePolicy', { a: bcs.bool(), b: bcs.bool(), c: bcs.bool(), d: bcs.bool() }),
  free_gate_fee_paid_mist: bcs.u64(),
  creator: bcs.Address,
  timestamp_ms: bcs.u64(),
})

let seq = 0
function entry(name: string, bytes: Uint8Array, pkg = PKG, checkpoint = '100'): CoreEventEntry {
  return {
    eventType: `${pkg}::access_gate::${name}`,
    sender: '0xa11ce',
    bcs: bytes,
    checkpoint,
    transactionDigest: `tx${++seq}`,
    eventIndex: 0,
  }
}
const mintedEntry = (gate: string, checkpoint = '100') =>
  entry(
    'AccessMintedEvent',
    minted
      .serialize({ nft_id: NFT, gate_id: gate, soulbound: false, initial_uses: 3, recipient: ALICE, commission_mist: 2000, timestamp_ms: 5 })
      .toBytes(),
    PKG,
    checkpoint,
  )
const consumedEntry = (gate: string, checkpoint = '100') =>
  entry(
    'AccessConsumedEvent',
    consumed
      .serialize({ nft_id: NFT, gate_id: gate, nonce: [...new TextEncoder().encode('nonce-123')], consumer: ALICE, uses_after: 2, timestamp_ms: 6 })
      .toBytes(),
    PKG,
    checkpoint,
  )

describe('parseAccessGateEvent', () => {
  it('decodes AccessConsumed with the consumer address and nonce', () => {
    const e = parseAccessGateEvent(consumedEntry(GATE_A), PKG)
    expect(e).toMatchObject({ kind: 'AccessConsumed', gateId: GATE_A, nftId: NFT, consumer: ALICE, usesAfter: 2n, timestampMs: 6n })
    expect(new TextDecoder().decode((e as { nonce: Uint8Array }).nonce)).toBe('nonce-123')
    expect(e?.sender).toBe(ALICE)
    expect(e?.checkpoint).toBe('100')
  })

  it('decodes AccessMinted', () => {
    expect(parseAccessGateEvent(mintedEntry(GATE_A), PKG)).toMatchObject({
      kind: 'AccessMinted',
      recipient: ALICE,
      initialUses: 3n,
      commissionMist: 2000n,
      soulbound: false,
    })
  })

  it('decodes GateCreated with its policy', () => {
    const bytes = created
      .serialize({
        gate_id: GATE_A,
        admin_cap_id: NFT,
        price_mist: 10_000_000,
        default_uses: 0,
        soulbound: true,
        auto_burn_at_zero: false,
        nft_name: 'Relay pass',
        policy: { a: true, b: false, c: false, d: true },
        free_gate_fee_paid_mist: 0,
        creator: ALICE,
        timestamp_ms: 9,
      })
      .toBytes()
    expect(parseAccessGateEvent(entry('GateCreatedEvent', bytes), PKG)).toMatchObject({
      kind: 'GateCreated',
      nftName: 'Relay pass',
      priceMist: 10_000_000n,
      soulbound: true,
      creator: ALICE,
      policy: { freezeRequiresUnpaused: true, lockCommissionOnFreeze: false, pauseBlocksDecryption: false, pauseBlocksAccess: true },
    })
  })

  it('decodes an Option of commission terms', () => {
    const some = frozen.serialize({ gate_id: GATE_A, locked_commission: { bps: 20, min_mist: 1000 }, timestamp_ms: 1 }).toBytes()
    const none = frozen.serialize({ gate_id: GATE_A, locked_commission: null, timestamp_ms: 1 }).toBytes()
    expect(parseAccessGateEvent(entry('GateFrozenEvent', some), PKG)).toMatchObject({ lockedCommission: { bps: 20n, minMist: 1000n } })
    expect(parseAccessGateEvent(entry('GateFrozenEvent', none), PKG)).toMatchObject({ lockedCommission: null })
  })

  it('decodes PlatformMigrated, which concerns no gate', () => {
    const bytes = migrated.serialize({ from_version: 1, to_version: 2 }).toBytes()
    const e = parseAccessGateEvent(entry('PlatformMigratedEvent', bytes), PKG)
    expect(e).toMatchObject({ kind: 'PlatformMigrated', fromVersion: 1n, toVersion: 2n })
    expect(eventGateId(e!)).toBeNull()
  })

  it('decodes PlatformConfigUpdated, which concerns no gate', () => {
    const bytes = platform
      .serialize({ treasury: ALICE, commission_bps: 20, min_commission_mist: 1_000_000, free_gate_fee_mist: 100_000_000 })
      .toBytes()
    const e = parseAccessGateEvent(entry('PlatformConfigUpdatedEvent', bytes), PKG)
    expect(e).toMatchObject({ kind: 'PlatformConfigUpdated', treasury: ALICE, commissionBps: 20n, freeGateFeeMist: 100_000_000n })
    expect(e && eventGateId(e)).toBeNull()
  })

  it('accepts base64 BCS (indexer rows) and long-form addresses', () => {
    const e = mintedEntry(GATE_A)
    const row = { ...e, bcs: toBase64(e.bcs as Uint8Array), eventType: `${PKG_LONG}::access_gate::AccessMintedEvent` }
    expect(parseAccessGateEvent(row, PKG)?.kind).toBe('AccessMinted')
  })

  it('rejects trailing bytes: a field appended by a later upgrade must not decode silently', () => {
    const e = mintedEntry(GATE_A)
    const longer = new Uint8Array([...(e.bcs as Uint8Array), 1, 2, 3])
    expect(() => parseAccessGateEvent({ ...e, bcs: longer }, PKG)).toThrow(/layout/)
    expect(() => parseAccessGateEvent({ ...e, bcs: (e.bcs as Uint8Array).slice(0, -1) }, PKG)).toThrow()
  })

  it('does not treat Object prototype keys as event names', () => {
    const e = mintedEntry(GATE_A)
    for (const name of ['constructor', 'toString', 'hasOwnProperty']) {
      expect(parseAccessGateEvent({ ...e, eventType: `${PKG}::access_gate::${name}` }, PKG)).toBeNull()
    }
  })

  it('rejects events of a look-alike package, other modules and unknown names', () => {
    const e = mintedEntry(GATE_A)
    expect(parseAccessGateEvent({ ...e, eventType: `${LOOKALIKE}::access_gate::AccessMintedEvent` }, PKG)).toBeNull()
    expect(parseAccessGateEvent({ ...e, eventType: `${PKG}::other::AccessMintedEvent` }, PKG)).toBeNull()
    expect(parseAccessGateEvent({ ...e, eventType: `${PKG}::access_gate::Unknown` }, PKG)).toBeNull()
  })

  it('throws on bytes that do not decode', () => {
    expect(() => parseAccessGateEvent(entry('AccessMintedEvent', new Uint8Array([1, 2])), PKG)).toThrow()
  })

  it('names every kind at the original id', () => {
    expect(ACCESS_GATE_EVENT_KINDS).toHaveLength(8)
    expect(accessGateEventType(PKG, 'AccessConsumed')).toBe(`${PKG_LONG}::access_gate::AccessConsumedEvent`)
  })
})

/** A client serving `pages` newest first (cursor = page index). */
function eventsClient(pages: CoreEventEntry[][]) {
  const listEvents = vi.fn(async ({ before }: { before?: string | null }) => {
    const i = before ? Number(before) : 0
    const hasNextPage = i + 1 < pages.length
    return { events: pages[i] ?? [], hasNextPage, endCursor: hasNextPage ? String(i + 1) : null }
  })
  return { core: { listEvents } } satisfies EventsClient
}

describe('listAccessGateEvents (full node)', () => {
  it('queries the whole module for several kinds and filters here', async () => {
    const client = eventsClient([[mintedEntry(GATE_A, '9'), consumedEntry(GATE_A, '8')]])
    const page = await listAccessGateEvents(client, { originalId: PKG, kinds: ['AccessConsumed', 'AccessBurned'] })
    expect(client.core.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { eventType: `${PKG_LONG}::access_gate` }, order: 'descending' }),
    )
    expect(page.events.map((e) => e.kind)).toEqual(['AccessConsumed'])
    expect(page).toMatchObject({ source: 'rpc', cursor: null })
  })

  it('uses the exact event type for a single kind and asks for exactly `limit`', async () => {
    const client = eventsClient([[mintedEntry(GATE_A)]])
    await listAccessGateEvents(client, { originalId: PKG, kinds: ['AccessMinted'], limit: 5 })
    expect(client.core.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ filter: { eventType: `${PKG_LONG}::access_gate::AccessMintedEvent` }, limit: 5 }),
    )
  })

  it('filters by gate across pages and returns a continuation cursor', async () => {
    const client = eventsClient([[mintedEntry(GATE_B)], [mintedEntry(GATE_A)], [mintedEntry(GATE_A)]])
    const page = await listAccessGateEvents(client, { originalId: PKG, gateId: '0xa', limit: 1 })
    expect(page.events).toHaveLength(1)
    expect(page.cursor).toEqual({ source: 'rpc', value: '2' })
    const next = await listAccessGateEvents(client, { originalId: PKG, gateId: '0xa', limit: 1, cursor: page.cursor })
    expect(next.events).toHaveLength(1)
    expect(next.cursor).toBeNull()
  })

  it('stops after maxPages without filling the page', async () => {
    const client = eventsClient([[mintedEntry(GATE_B)], [mintedEntry(GATE_B)], [mintedEntry(GATE_A)]])
    const page = await listAccessGateEvents(client, { originalId: PKG, gateId: GATE_A, maxPages: 2 })
    expect(page.events).toEqual([])
    expect(page.cursor).toEqual({ source: 'rpc', value: '2' })
  })

  it('refuses an indexer cursor without the indexer', async () => {
    await expect(
      listAccessGateEvents(eventsClient([[]]), { originalId: PKG, cursor: { source: 'indexer', value: 'x' } }),
    ).rejects.toThrow(/indexer cursor/)
  })
})

describe('listAccessGateEvents (indexer)', () => {
  const INDEXER = 'https://indexer.example'
  const row = (e: CoreEventEntry) => ({ ...e, bcs: toBase64(e.bcs as Uint8Array) })

  it('reads from the indexer and keeps only this package\'s events of the asked kinds', async () => {
    const fake = { ...row(mintedEntry(GATE_A)), eventType: `${LOOKALIKE}::access_gate::AccessMintedEvent` }
    const fetchFn = vi.fn(async () =>
      Response.json({ events: [row(consumedEntry(GATE_A)), row(mintedEntry(GATE_A)), fake], cursor: 'c1', indexedFromCheckpoint: '42', polledAt: Date.now() }),
    )
    const client = eventsClient([[]])
    const page = await listAccessGateEvents(client, {
      originalId: PKG,
      kinds: ['AccessConsumed'],
      gateId: '0xa',
      limit: 10,
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
    })
    expect(page.source).toBe('indexer')
    expect(page.events.map((e) => e.kind)).toEqual(['AccessConsumed'])
    expect(page.cursor).toEqual({ source: 'indexer', value: 'c1' })
    expect(page.indexedFromCheckpoint).toBe('42')
    expect(client.core.listEvents).not.toHaveBeenCalled()
    const url = new URL(String((fetchFn.mock.calls[0] as unknown[])[0]))
    expect(url.pathname).toBe('/v1/testnet/access-gate/events')
    expect(url.searchParams.get('kinds')).toBe('AccessConsumed')
    expect(url.searchParams.get('gate')).toBe(GATE_A)
    expect(url.searchParams.get('limit')).toBe('10')
  })

  it('falls back to the full node on a first page and says why', async () => {
    const fetchFn = vi.fn(async () => new Response('down', { status: 503 }))
    const client = eventsClient([[mintedEntry(GATE_A)]])
    const page = await listAccessGateEvents(client, {
      originalId: PKG,
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
    })
    expect(page.source).toBe('rpc')
    expect(page.events).toHaveLength(1)
    expect(page.indexerError).toMatch(/503/)
  })

  it('does not switch source mid-listing', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('timeout')
    })
    const client = eventsClient([[mintedEntry(GATE_A)]])
    await expect(
      listAccessGateEvents(client, {
        originalId: PKG,
        cursor: { source: 'indexer', value: 'c1' },
        indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
      }),
    ).rejects.toThrow('timeout')
    expect(client.core.listEvents).not.toHaveBeenCalled()
  })

  it('continues an rpc cursor on the full node even with an indexer configured', async () => {
    const fetchFn = vi.fn()
    const client = eventsClient([[], [mintedEntry(GATE_A)]])
    const page = await listAccessGateEvents(client, {
      originalId: PKG,
      cursor: { source: 'rpc', value: '1' },
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
    })
    expect(page.events).toHaveLength(1)
    expect(fetchFn).not.toHaveBeenCalled()
  })
})

describe('indexer rows are untrusted (display-only)', () => {
  const INDEXER = 'https://indexer.example'
  const row = (e: CoreEventEntry) => ({ ...e, bcs: toBase64(e.bcs as Uint8Array) })

  it('skips and counts malformed or undecodable rows instead of failing the page', async () => {
    const good = row(mintedEntry(GATE_A))
    const rows = [
      good,
      { ...good, sender: undefined }, // no sender
      { ...good, eventIndex: 'x' }, // mistyped origin field
      { ...good, transactionDigest: 5 },
      { ...good, bcs: 'not base64 !!' },
      { ...good, bcs: toBase64(new Uint8Array([1, 2, 3])) }, // undecodable
      null,
      'junk',
    ]
    const fetchFn = vi.fn(async () => Response.json({ events: rows, cursor: 'c2' }))
    const page = await listAccessGateEvents(eventsClient([[]]), {
      originalId: PKG,
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
      cursor: { source: 'indexer', value: 'c1' },
    })
    expect(page.events).toHaveLength(1)
    expect(page.invalidRows).toBe(rows.length - 1)
    expect(page.cursor).toEqual({ source: 'indexer', value: 'c2' }) // pagination survives
  })

  it('full-node rows keep throwing: that is real layout drift', async () => {
    const e = mintedEntry(GATE_A)
    const client = eventsClient([[{ ...e, bcs: new Uint8Array([1]) }]])
    await expect(listAccessGateEvents(client, { originalId: PKG })).rejects.toThrow()
  })
})

describe('readIndexerEvents (shared indexer reader)', () => {
  const respond = (body: string, status = 200) => vi.fn(async () => new Response(body, { status }))
  /** A fresh head page body (the checks below are about the other fields). */
  const head = (extra: Record<string, unknown> = {}) => JSON.stringify({ events: [], cursor: null, polledAt: Date.now(), ...extra })
  const source = (url: string, fetchFn: ReturnType<typeof vi.fn>) => ({ url, network: 'testnet', fetch: fetchFn as unknown as typeof fetch })

  it('builds the URL from parsed parts and drops undefined params', async () => {
    const polledAt = Date.now()
    const fetchFn = respond(JSON.stringify({ events: [], cursor: null, indexedFromCheckpoint: '7', polledAt }))
    const page = await readIndexerEvents(source('https://idx.example/base', fetchFn), 'v1/testnet/x', { a: '1', b: undefined })
    expect(page).toEqual({ events: [], cursor: null, indexedFromCheckpoint: '7', polledAt })
    expect(String((fetchFn.mock.calls[0] as unknown[])[0])).toBe('https://idx.example/base/v1/testnet/x?a=1')
  })

  it('refuses a plain-http indexer except on loopback', async () => {
    const fetchFn = respond(head())
    await expect(readIndexerEvents(source('http://idx.example', fetchFn), 'v1', {})).rejects.toThrow(/https/)
    await expect(readIndexerEvents(source('http://127.0.0.1:8080', fetchFn), 'v1', {})).resolves.toMatchObject({ events: [] })
  })

  it('refuses a path that leaves the indexer origin, and redirects', async () => {
    const fetchFn = respond(head())
    for (const path of ['//evil.example/x', 'https://evil.example/x', '/abs', 'http:foo', 'a\\b']) {
      await expect(readIndexerEvents(source('https://idx.example', fetchFn), path, {})).rejects.toThrow(/relative|origin/)
    }
    expect(fetchFn).not.toHaveBeenCalled()
    await readIndexerEvents(source('https://idx.example', fetchFn), 'v1/x', {})
    const init = (fetchFn.mock.calls[0] as unknown as [unknown, RequestInit])[1]
    expect(init.redirect).toBe('error')
    expect(init.cache).toBe('no-store')
  })

  it('caps the body by bytes while streaming, even without a Content-Length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(1 << 18))
      },
    })
    const fetchFn = vi.fn(async () => new Response(stream, { status: 200 }))
    await expect(readIndexerEvents(source('https://idx.example', fetchFn), 'v1', {})).rejects.toThrow(/too large/)
    // Multi-byte text is counted in bytes, not UTF-16 units.
    const wide = respond(head({ pad: '€'.repeat(400_000) }))
    await expect(readIndexerEvents(source('https://idx.example', wide), 'v1', {})).rejects.toThrow(/too large/)
  })

  it('rejects oversized, non-JSON and mis-shaped bodies', async () => {
    const url = 'https://idx.example'
    await expect(readIndexerEvents(source(url, respond('x'.repeat((1 << 20) + 1))), 'v1', {})).rejects.toThrow(/too large/)
    await expect(readIndexerEvents(source(url, respond('<html>')), 'v1', {})).rejects.toThrow(/not JSON/)
    await expect(readIndexerEvents(source(url, respond('{}')), 'v1', {})).rejects.toThrow(/no events list/)
    await expect(readIndexerEvents(source(url, respond(head({ cursor: 5 }))), 'v1', {})).rejects.toThrow(/cursor/)
    await expect(
      readIndexerEvents(source(url, respond(head({ indexedFromCheckpoint: 1 }))), 'v1', {}),
    ).rejects.toThrow(/checkpoint/)
    await expect(readIndexerEvents(source(url, respond('', 502)), 'v1', {})).rejects.toThrow(/502/)
  })
})

describe('a stale head page counts as unavailable (sui-indexer F19)', () => {
  const INDEXER = 'https://indexer.example'
  const NOW = 1_800_000_000_000
  const row = (e: CoreEventEntry) => ({ ...e, bcs: toBase64(e.bcs as Uint8Array) })
  const serving = (body: Record<string, unknown>) =>
    vi.fn(async () => Response.json({ events: [row(mintedEntry(GATE_A))], cursor: 'c1', ...body }))
  const list = (fetchFn: ReturnType<typeof vi.fn>, extra: Partial<ListAccessGateEventsOptions> = {}) => {
    const client = eventsClient([[mintedEntry(GATE_A)]])
    const page = listAccessGateEvents(client, {
      originalId: PKG,
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
      ...extra,
    })
    return { client, page }
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a fresh head page', async () => {
    const { client, page } = list(serving({ polledAt: NOW - 15_000 }))
    const p = await page
    expect(p.source).toBe('indexer')
    expect(p.indexerError).toBeUndefined()
    expect(client.core.listEvents).not.toHaveBeenCalled()
  })

  it('uses a page exactly STALE_AFTER_MS old, and falls back one millisecond later', async () => {
    expect(STALE_AFTER_MS).toBe(60_000)
    expect((await list(serving({ polledAt: NOW - STALE_AFTER_MS })).page).source).toBe('indexer')
    const { client, page } = list(serving({ polledAt: NOW - STALE_AFTER_MS - 1 }))
    const p = await page
    expect(p.source).toBe('rpc')
    expect(p.indexerError).toMatch(/stale/)
    expect(client.core.listEvents).toHaveBeenCalledTimes(1)
  })

  it('falls back to the full node when the head page is stale', async () => {
    const { client, page } = list(serving({ polledAt: NOW - 10 * 60_000 }))
    const p = await page
    expect(p.source).toBe('rpc')
    expect(p.events).toHaveLength(1)
    expect(p.indexerError).toMatch(/stale: last poll 600 s ago/)
    expect(client.core.listEvents).toHaveBeenCalledTimes(1)
  })

  it('falls back when polledAt is null or missing (the indexer has not polled yet)', async () => {
    for (const body of [{ polledAt: null }, {}]) {
      const { client, page } = list(serving(body))
      const p = await page
      expect(p.source).toBe('rpc')
      expect(p.indexerError).toMatch(/no polledAt/)
      expect(client.core.listEvents).toHaveBeenCalledTimes(1)
    }
  })

  it('falls back when polledAt is not an epoch-ms number', async () => {
    for (const polledAt of ['1800000000000', 0, -5, 1.5, true, {}, NaN, Number.MAX_SAFE_INTEGER + 2]) {
      const { client, page } = list(serving({ polledAt }))
      const p = await page
      expect(p.source, String(polledAt)).toBe('rpc')
      expect(p.indexerError).toMatch(/polledAt/)
      expect(client.core.listEvents).toHaveBeenCalledTimes(1)
    }
  })

  it('tolerates a polledAt in the future up to CLOCK_SKEW_TOLERANCE_MS, and falls back beyond it', async () => {
    expect(CLOCK_SKEW_TOLERANCE_MS).toBe(300_000)
    expect((await list(serving({ polledAt: NOW + 60_000 })).page).source).toBe('indexer')
    expect((await list(serving({ polledAt: NOW + CLOCK_SKEW_TOLERANCE_MS })).page).source).toBe('indexer')
    const { client, page } = list(serving({ polledAt: NOW + CLOCK_SKEW_TOLERANCE_MS + 1 }))
    const p = await page
    expect(p.source).toBe('rpc')
    expect(p.indexerError).toMatch(/future/)
    expect(client.core.listEvents).toHaveBeenCalledTimes(1)
  })

  it('does not check staleness on an older page (immutable history), which carries no polledAt', async () => {
    const fetchFn = serving({})
    const client = eventsClient([[]])
    const page = await listAccessGateEvents(client, {
      originalId: PKG,
      cursor: { source: 'indexer', value: 'c0' },
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
    })
    expect(page.source).toBe('indexer')
    expect(client.core.listEvents).not.toHaveBeenCalled()
    expect(new URL(String((fetchFn.mock.calls[0] as unknown[])[0])).searchParams.get('before')).toBe('c0')
  })

  it('a polledAt on an older page is ignored, whatever its age', async () => {
    const fetchFn = serving({ polledAt: NOW - 24 * 3_600_000 })
    const client = eventsClient([[]])
    const page = await listAccessGateEvents(client, {
      originalId: PKG,
      cursor: { source: 'indexer', value: 'c0' },
      indexer: { url: INDEXER, network: 'testnet', fetch: fetchFn as unknown as typeof fetch },
    })
    expect(page.source).toBe('indexer')
  })

  it('staleAfterMs overrides the limit; an invalid value is ignored', async () => {
    const polledAt = NOW - 30_000
    const tight = list(serving({ polledAt }), {
      indexer: { url: INDEXER, network: 'testnet', staleAfterMs: 10_000, fetch: serving({ polledAt }) as unknown as typeof fetch },
    })
    expect((await tight.page).source).toBe('rpc')
    const loose = list(serving({ polledAt: NOW - 120_000 }), {
      indexer: { url: INDEXER, network: 'testnet', staleAfterMs: 180_000, fetch: serving({ polledAt: NOW - 120_000 }) as unknown as typeof fetch },
    })
    expect((await loose.page).source).toBe('indexer')
    for (const staleAfterMs of [0, -1, NaN, Infinity]) {
      const f = serving({ polledAt: NOW - STALE_AFTER_MS - 1 })
      const bad = list(f, { indexer: { url: INDEXER, network: 'testnet', staleAfterMs, fetch: f as unknown as typeof fetch } })
      expect((await bad.page).source, String(staleAfterMs)).toBe('rpc')
    }
  })

  it('readIndexerEvents throws on a stale head page and returns polledAt on a fresh one', async () => {
    const src = (body: Record<string, unknown>) => ({
      url: INDEXER,
      network: 'testnet',
      fetch: (async () => Response.json({ events: [], cursor: null, ...body })) as unknown as typeof fetch,
    })
    await expect(readIndexerEvents(src({ polledAt: NOW - 61_000 }), 'v1/x', {})).rejects.toThrow(/stale/)
    await expect(readIndexerEvents(src({ polledAt: null }), 'v1/x', { before: undefined })).rejects.toThrow(/stale/)
    await expect(readIndexerEvents(src({ polledAt: NOW }), 'v1/x', {})).resolves.toMatchObject({ polledAt: NOW })
    // `before` marks history: no check, no polledAt in the result.
    const old = await readIndexerEvents(src({}), 'v1/x', { before: 'c0' })
    expect(old).not.toHaveProperty('polledAt')
  })
})
