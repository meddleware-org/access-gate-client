import { describe, it, expect, vi } from 'vitest'
import {
  parseOwnedAccessNft,
  fetchAccessNfts,
  ownsAccessNft,
  isUsablePass,
  fetchAccessNftById,
  listAllOwnedObjects,
  MAX_OWNED_PAGES,
} from '../src/ownership.js'
import { normalizeSuiAddress as N } from '@mysten/sui/utils'
import type { CoreObject, OwnedObjectsClient, SuiObjectClient } from '../src/types.js'

// Short-form ids on purpose: matching must normalise addresses.
const PKG = '0xa1'
const PKG_LONG = `0x${'0'.repeat(62)}a1`
const NFT_TYPE = `${PKG}::access_gate::AccessNFT`
const SB_TYPE = `${PKG}::access_gate::SoulboundAccessNFT`
const GATE_A = '0xa'
const GATE_B = '0xb'

/** A core-API owned object (gRPC): id + type top-level, Move struct fields flat under `json`. */
function coreObj(objectId: string, gateId: string, uses?: number | bigint, type = NFT_TYPE): CoreObject {
  return {
    objectId,
    type,
    json: {
      id: { id: objectId },
      data: {
        gate_id: gateId,
        minted_epoch: '10',
        // The rendering a real full node returns (pinned live against a testnet pass).
        variant: uses === undefined ? { '@variant': 'UnlimitedPass' } : { '@variant': 'SingleUse', uses_remaining: String(uses) },
      },
    },
  }
}

/** A client serving `pages` in order (cursor = page index). */
function pagedClient(pages: CoreObject[][]): OwnedObjectsClient & { core: { listOwnedObjects: ReturnType<typeof vi.fn> } } {
  const listOwnedObjects = vi.fn(async ({ cursor }: { cursor?: string | null }) => {
    const i = cursor ? Number(cursor) : 0
    const hasNextPage = i + 1 < pages.length
    return { objects: pages[i] ?? [], hasNextPage, cursor: hasNextPage ? String(i + 1) : null }
  })
  return { core: { listOwnedObjects } }
}

const UNLIMITED = { kind: 'unlimited' } as const
const single = (n: bigint) => ({ kind: 'singleUse', remaining: n }) as const

describe('parseOwnedAccessNft', () => {
  it('parses an unlimited pass', () => {
    expect(parseOwnedAccessNft(coreObj('0x1', GATE_A), NFT_TYPE)).toEqual({ objectId: N('0x1'), gateId: N(GATE_A), variant: UNLIMITED })
  })

  it('parses a single-use NFT with its remaining count as a bigint', () => {
    expect(parseOwnedAccessNft(coreObj('0x2', GATE_A, 3), NFT_TYPE)).toEqual({ objectId: N('0x2'), gateId: N(GATE_A), variant: single(3n) })
    expect(parseOwnedAccessNft(coreObj('0x2', GATE_A, 0), NFT_TYPE)?.variant).toEqual(single(0n))
  })

  it('matches the type with addresses normalised', () => {
    const long = coreObj('0x1', GATE_A, 1, `${PKG_LONG}::access_gate::AccessNFT`)
    expect(parseOwnedAccessNft(long, NFT_TYPE)?.variant).toEqual(single(1n))
  })

  it('rejects a same-named struct from a look-alike package', () => {
    const fake = coreObj('0x1', GATE_A, 1, '0xa1a1::access_gate::AccessNFT')
    expect(parseOwnedAccessNft(fake, NFT_TYPE)).toBeNull()
  })

  it('rejects the other NFT flavour and objects without a type', () => {
    expect(parseOwnedAccessNft(coreObj('0x1', GATE_A, 1, SB_TYPE), NFT_TYPE)).toBeNull()
    expect(parseOwnedAccessNft({ objectId: '0x1', json: coreObj('0x1', GATE_A).json }, NFT_TYPE)).toBeNull()
  })

  it('supports the soulbound NFT type', () => {
    expect(parseOwnedAccessNft(coreObj('0x1', GATE_A, 2, SB_TYPE), SB_TYPE)?.variant).toEqual(single(2n))
  })

  it('throws when asked to match a type that is not an access NFT', () => {
    expect(() => parseOwnedAccessNft(coreObj('0x1', GATE_A), `${PKG}::access_gate::Gate`)).toThrow(/not an access_gate NFT type/)
    expect(() => parseOwnedAccessNft(coreObj('0x1', GATE_A), 'nonsense')).toThrow(/not an access_gate NFT type/)
  })

  it('accepts a getObject result ({ object })', () => {
    expect(parseOwnedAccessNft({ object: coreObj('0x4', GATE_A, 1) }, NFT_TYPE)?.objectId).toBe(N('0x4'))
  })

  it('rejects an NFT whose gate id is not an address', () => {
    expect(parseOwnedAccessNft(coreObj('0x1', 'gate-a'), NFT_TYPE)).toBeNull()
  })
})

describe('pass variant fails closed', () => {
  const withVariant = (variant: unknown) => ({ objectId: '0xf', type: NFT_TYPE, json: { data: { gate_id: GATE_A, variant } } })

  it('rejects every variant it cannot parse instead of reading it as unlimited', () => {
    for (const bad of [
      undefined,
      null,
      'UnlimitedPass',
      {},
      { '@variant': 'Mystery' },
      { '@variant': 'SingleUse' },
      { '@variant': 'SingleUse', uses_remaining: 'lots' },
      { '@variant': 'SingleUse', uses_remaining: '-1' },
      { '@variant': 'SingleUse', uses_remaining: '18446744073709551616' },
      { variant: 'SingleUse', fields: { uses_remaining: '5' } },
      { variant: 'UnlimitedPass', fields: {} },
    ]) {
      expect(parseOwnedAccessNft(withVariant(bad), NFT_TYPE)).toBeNull()
    }
  })

  it('keeps u64 counts exact, including the maximum', () => {
    expect(parseOwnedAccessNft(withVariant({ '@variant': 'SingleUse', uses_remaining: '9007199254740993' }), NFT_TYPE)?.variant).toEqual(single(9007199254740993n))
    expect(parseOwnedAccessNft(withVariant({ '@variant': 'SingleUse', uses_remaining: '18446744073709551615' }), NFT_TYPE)?.variant).toEqual(single(18446744073709551615n))
  })
})

describe('isUsablePass', () => {
  it('counts unlimited and non-empty single-use passes only', () => {
    expect(isUsablePass({ variant: UNLIMITED })).toBe(true)
    expect(isUsablePass({ variant: single(1n) })).toBe(true)
    expect(isUsablePass({ variant: single(0n) })).toBe(false)
  })
})

describe('owned-object reads (gRPC core API)', () => {
  it('fetchAccessNfts reads every page', async () => {
    const client = pagedClient([[coreObj('0x1', GATE_A)], [coreObj('0x2', GATE_B, 1)], [coreObj('0x3', GATE_A, 2)]])
    const all = await fetchAccessNfts(client, '0xowner', NFT_TYPE)
    expect(all.map((n) => n.objectId)).toEqual(['0x1', '0x2', '0x3'].map((x) => N(x)))
    expect(client.core.listOwnedObjects).toHaveBeenCalledTimes(3)
    expect(client.core.listOwnedObjects.mock.calls[1]![0]).toMatchObject({ cursor: '1' })
  })

  it('fetchAccessNfts filters by gate id', async () => {
    const client = pagedClient([[coreObj('0x1', GATE_A), coreObj('0x2', GATE_B, 1)]])
    const onlyA = await fetchAccessNfts(client, '0xowner', NFT_TYPE, GATE_A)
    expect(onlyA.map((n) => n.objectId)).toEqual([N('0x1')])
  })

  it('compares gate ids normalised (short, long and upper-case forms match)', async () => {
    const client = pagedClient([[coreObj('0x1', GATE_A), coreObj('0x2', GATE_B, 1)]])
    expect((await fetchAccessNfts(client, '0xowner', NFT_TYPE, N(GATE_A))).map((n) => n.objectId)).toEqual([N('0x1')])
    expect(await ownsAccessNft(pagedClient([[coreObj('0x1', GATE_A)]]), '0xowner', NFT_TYPE, '0xA')).toBe(true)
    expect(await ownsAccessNft(pagedClient([[coreObj('0x1', GATE_A)]]), '0xowner', NFT_TYPE, N(GATE_B))).toBe(false)
  })

  it('queries the normalised type with json', async () => {
    const client = pagedClient([[]])
    await fetchAccessNfts(client, '0xowner', NFT_TYPE)
    expect(client.core.listOwnedObjects).toHaveBeenCalledWith(
      expect.objectContaining({ owner: '0xowner', type: `${PKG_LONG}::access_gate::AccessNFT`, include: { json: true } }),
    )
  })

  it('ownsAccessNft finds a match on a later page and stops there', async () => {
    const client = pagedClient([[coreObj('0x1', GATE_B)], [coreObj('0x2', GATE_A)], [coreObj('0x3', GATE_A)]])
    expect(await ownsAccessNft(client, '0xo', NFT_TYPE, GATE_A)).toBe(true)
    expect(client.core.listOwnedObjects).toHaveBeenCalledTimes(2)
  })

  it('ownsAccessNft is false without a matching NFT', async () => {
    expect(await ownsAccessNft(pagedClient([[coreObj('0x1', GATE_A)]]), '0xo', NFT_TYPE, GATE_B)).toBe(false)
    expect(await ownsAccessNft(pagedClient([[]]), '0xo', NFT_TYPE)).toBe(false)
  })

  it('ownsAccessNft counts usable passes only by default', async () => {
    const spent = () => pagedClient([[coreObj('0x1', GATE_A, 0)]])
    expect(await ownsAccessNft(spent(), '0xo', NFT_TYPE, GATE_A)).toBe(false)
    expect(await ownsAccessNft(spent(), '0xo', NFT_TYPE, GATE_A, { usable: false })).toBe(true)
    expect(await ownsAccessNft(pagedClient([[coreObj('0x1', GATE_A, 0), coreObj('0x2', GATE_A, 1)]]), '0xo', NFT_TYPE, GATE_A)).toBe(true)
    expect(await ownsAccessNft(pagedClient([[coreObj('0x1', GATE_A)]]), '0xo', NFT_TYPE, GATE_A)).toBe(true)
  })

  it('ownsAccessNft never counts a pass whose variant is unknown', async () => {
    const unknown: CoreObject = { objectId: '0x1', type: NFT_TYPE, json: { data: { gate_id: GATE_A, variant: { '@variant': 'Mystery' } } } }
    expect(await ownsAccessNft(pagedClient([[unknown]]), '0xo', NFT_TYPE, GATE_A)).toBe(false)
    expect(await ownsAccessNft(pagedClient([[unknown]]), '0xo', NFT_TYPE, GATE_A, { usable: false })).toBe(false)
  })

  it('listAllOwnedObjects refuses to truncate past the page budget', async () => {
    const endless: OwnedObjectsClient = {
      core: { listOwnedObjects: vi.fn(async () => ({ objects: [], hasNextPage: true, cursor: 'next' })) },
    }
    await expect(listAllOwnedObjects(endless, '0xo', NFT_TYPE)).rejects.toThrow(`more than ${MAX_OWNED_PAGES} pages`)
  })

  it('fetchAccessNftById does a typed getObject and parses it', async () => {
    const getObject = vi.fn(async () => ({ object: coreObj('0x9f', GATE_A, 4) }))
    const client: SuiObjectClient = { core: { getObject } }
    expect(await fetchAccessNftById(client, '0x9f', NFT_TYPE)).toEqual({ objectId: N('0x9f'), gateId: N(GATE_A), variant: single(4n) })
    expect(getObject).toHaveBeenCalledWith(expect.objectContaining({ objectId: '0x9f', include: { json: true } }))
  })
})
