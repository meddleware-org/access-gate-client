import { describe, it, expect, vi } from 'vitest'
import {
  parseOwnedAccessNft,
  fetchAccessNfts,
  ownsAccessNft,
  fetchAccessNftById,
  listAllOwnedObjects,
  MAX_OWNED_PAGES,
} from '../src/ownership.js'
import type { CoreObject, OwnedObjectsClient, SuiObjectClient } from '../src/types.js'

// Short-form ids on purpose: matching must normalise addresses.
const PKG = '0xa1'
const PKG_LONG = `0x${'0'.repeat(62)}a1`
const NFT_TYPE = `${PKG}::access_gate::AccessNFT`
const SB_TYPE = `${PKG}::access_gate::SoulboundAccessNFT`
const GATE_A = '0xa'
const GATE_B = '0xb'

/** A core-API owned object (gRPC): id + type top-level, Move struct fields flat under `json`. */
function coreObj(objectId: string, gateId: string, uses?: number, type = NFT_TYPE): CoreObject {
  return {
    objectId,
    type,
    json: {
      id: { id: objectId },
      data: {
        gate_id: gateId,
        minted_epoch: '10',
        variant:
          uses === undefined
            ? { variant: 'UnlimitedPass', fields: {} }
            : { variant: 'SingleUse', fields: { uses_remaining: String(uses) } },
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

describe('parseOwnedAccessNft', () => {
  it('parses an unlimited pass (usesRemaining null)', () => {
    expect(parseOwnedAccessNft(coreObj('0x1', GATE_A), NFT_TYPE)).toEqual({ objectId: '0x1', gateId: GATE_A, usesRemaining: null })
  })

  it('parses a single-use NFT with remaining count', () => {
    expect(parseOwnedAccessNft(coreObj('0x2', GATE_A, 3), NFT_TYPE)).toEqual({ objectId: '0x2', gateId: GATE_A, usesRemaining: 3 })
  })

  it('matches the type with addresses normalised', () => {
    const long = coreObj('0x1', GATE_A, 1, `${PKG_LONG}::access_gate::AccessNFT`)
    expect(parseOwnedAccessNft(long, NFT_TYPE)?.usesRemaining).toBe(1)
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
    expect(parseOwnedAccessNft(coreObj('0x1', GATE_A, 2, SB_TYPE), SB_TYPE)?.usesRemaining).toBe(2)
  })

  it('throws when asked to match a type that is not an access NFT', () => {
    expect(() => parseOwnedAccessNft(coreObj('0x1', GATE_A), `${PKG}::access_gate::Gate`)).toThrow(/not an access_gate NFT type/)
    expect(() => parseOwnedAccessNft(coreObj('0x1', GATE_A), 'nonsense')).toThrow(/not an access_gate NFT type/)
  })

  it('usesRemaining is driven by the enum variant tag (typed)', () => {
    expect(parseOwnedAccessNft(coreObj('0x1', GATE_A), NFT_TYPE)?.usesRemaining).toBeNull()
    expect(parseOwnedAccessNft(coreObj('0x2', GATE_A, 0), NFT_TYPE)?.usesRemaining).toBe(0)
    expect(parseOwnedAccessNft(coreObj('0x3', GATE_A, 7), NFT_TYPE)?.usesRemaining).toBe(7)
  })

  it('tolerates the nested `.fields` shape (transport robustness)', () => {
    const nested: CoreObject = {
      objectId: '0xn',
      type: NFT_TYPE,
      json: { fields: { data: { fields: { gate_id: GATE_A, variant: { variant: 'SingleUse', fields: { uses_remaining: '5' } } } } } },
    }
    expect(parseOwnedAccessNft(nested, NFT_TYPE)).toEqual({ objectId: '0xn', gateId: GATE_A, usesRemaining: 5 })
  })

  it('accepts a getObject result ({ object })', () => {
    expect(parseOwnedAccessNft({ object: coreObj('0x4', GATE_A, 1) }, NFT_TYPE)?.objectId).toBe('0x4')
  })
})

describe('uses_remaining u64 parsing', () => {
  const withUses = (raw: string) => ({
    objectId: '0xu',
    type: NFT_TYPE,
    json: { data: { gate_id: GATE_A, variant: { variant: 'SingleUse', fields: { uses_remaining: raw } } } },
  })

  it('is exact up to MAX_SAFE_INTEGER and saturates above it', () => {
    expect(parseOwnedAccessNft(withUses('9007199254740991'), NFT_TYPE)?.usesRemaining).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseOwnedAccessNft(withUses('18446744073709551615'), NFT_TYPE)?.usesRemaining).toBe(Number.MAX_SAFE_INTEGER)
  })

  it('reports a malformed count as unknown, never 0', () => {
    expect(parseOwnedAccessNft(withUses('lots'), NFT_TYPE)?.usesRemaining).toBeNull()
  })
})

describe('owned-object reads (gRPC core API)', () => {
  it('fetchAccessNfts reads every page', async () => {
    const client = pagedClient([[coreObj('0x1', GATE_A)], [coreObj('0x2', GATE_B, 1)], [coreObj('0x3', GATE_A, 2)]])
    const all = await fetchAccessNfts(client, '0xowner', NFT_TYPE)
    expect(all.map((n) => n.objectId)).toEqual(['0x1', '0x2', '0x3'])
    expect(client.core.listOwnedObjects).toHaveBeenCalledTimes(3)
    expect(client.core.listOwnedObjects.mock.calls[1][0]).toMatchObject({ cursor: '1' })
  })

  it('fetchAccessNfts filters by gate id', async () => {
    const client = pagedClient([[coreObj('0x1', GATE_A), coreObj('0x2', GATE_B, 1)]])
    const onlyA = await fetchAccessNfts(client, '0xowner', NFT_TYPE, GATE_A)
    expect(onlyA.map((n) => n.objectId)).toEqual(['0x1'])
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

  it('listAllOwnedObjects refuses to truncate past the page budget', async () => {
    const endless: OwnedObjectsClient = {
      core: { listOwnedObjects: vi.fn(async () => ({ objects: [], hasNextPage: true, cursor: 'next' })) },
    }
    await expect(listAllOwnedObjects(endless, '0xo', NFT_TYPE)).rejects.toThrow(`more than ${MAX_OWNED_PAGES} pages`)
  })

  it('fetchAccessNftById does a typed getObject and parses it', async () => {
    const getObject = vi.fn(async () => ({ object: coreObj('0xnft', GATE_A, 4) }))
    const client: SuiObjectClient = { core: { getObject } }
    expect(await fetchAccessNftById(client, '0xnft', NFT_TYPE)).toEqual({ objectId: '0xnft', gateId: GATE_A, usesRemaining: 4 })
    expect(getObject).toHaveBeenCalledWith(expect.objectContaining({ objectId: '0xnft', include: { json: true } }))
  })
})
