import { describe, it, expect, vi } from 'vitest'
import { bcs } from '@mysten/sui/bcs'
import { normalizeSuiAddress, toBase64 } from '@mysten/sui/utils'
import {
  ACCESS_GATE_EVENT_KINDS,
  accessGateEventType,
  eventGateId,
  listAccessGateEvents,
  parseAccessGateEvent,
} from '../src/events.js'
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
      Response.json({ events: [row(consumedEntry(GATE_A)), row(mintedEntry(GATE_A)), fake], cursor: 'c1', indexedFromCheckpoint: '42' }),
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
