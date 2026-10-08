import { describe, it, expect, vi } from 'vitest'
import {
  parseAdminCap,
  parseGate,
  parsePlatformConfig,
  fetchPlatformConfig,
  fetchAdminCaps,
  fetchGate,
  fetchOwnedGates,
  ownsPlatformAdminCap,
} from '../src/gates.js'
import type { CoreObject, OwnedObjectsClient, SuiObjectClient } from '../src/types.js'

const PKG = '0xa1'
const PKG_LONG = `0x${'0'.repeat(62)}a1`
const LOOKALIKE = '0xa1a1'
const ADMIN_CAP_TYPE = `${PKG}::access_gate::AdminCap`
const GATE_TYPE = `${PKG}::access_gate::Gate`
// Parsers return normalised ids, so fixtures use the long form.
const id = (hex: string) => `0x${hex.padStart(64, '0')}`
const GATE_A = id('a')
const GATE_B = id('b')
const CAP_A = id('ca')
const CAP_B = id('cb')
const RECIPIENT = id('e1')
const TREASURY = id('7e')
const NO_POLICY = { freeze_requires_unpaused: false, lock_commission_on_freeze: false, pause_blocks_decryption: false, pause_blocks_access: false }

/** A core-API object (gRPC): id + type top-level, Move struct fields flat under `json`. */
function capObj(adminCapId: string, gateId: string): CoreObject {
  return { objectId: adminCapId, type: ADMIN_CAP_TYPE, json: { id: { id: adminCapId }, gate_id: gateId } }
}

function gateObj(gateId: string, over: Record<string, unknown> = {}): CoreObject {
  return {
    objectId: gateId,
    type: GATE_TYPE,
    json: {
      id: { id: gateId },
      admin_cap_id: CAP_A,
      price_mist: '1000',
      payment_recipient: RECIPIENT,
      default_uses: '3',
      soulbound: true,
      auto_burn_at_zero: false,
      paused: false,
      frozen: false,
      nft_name: 'Test Pass',
      nft_image_url: 'https://x/y.png',
      nft_description: 'desc',
      policy: NO_POLICY,
      locked_commission: null,
      free_fee_paid: false,
      ...over,
    },
  }
}

describe('gate discovery (gRPC core API)', () => {
  it('parseAdminCap reads adminCapId + gate_id', () => {
    expect(parseAdminCap(capObj(CAP_A, GATE_A), PKG)).toEqual({ adminCapId: CAP_A, gateId: GATE_A })
  })

  it('parseAdminCap rejects a non-AdminCap object', () => {
    const wrong: CoreObject = { objectId: '0x9', type: `${PKG}::other::Thing`, json: { gate_id: GATE_A } }
    expect(parseAdminCap(wrong, PKG)).toBeNull()
  })

  it('parseAdminCap rejects a look-alike package and an untyped object', () => {
    const fake: CoreObject = { ...capObj(CAP_A, GATE_A), type: `${LOOKALIKE}::access_gate::AdminCap` }
    expect(parseAdminCap(fake, PKG)).toBeNull()
    expect(parseAdminCap({ ...capObj(CAP_A, GATE_A), type: undefined }, PKG)).toBeNull()
  })

  it('parseGate rejects a Gate of a look-alike package', () => {
    expect(parseGate({ ...gateObj(GATE_A), type: `${LOOKALIKE}::access_gate::Gate` }, PKG)).toBeNull()
    expect(parseGate({ ...gateObj(GATE_A), type: `${PKG_LONG}::access_gate::Gate` }, PKG)?.gateId).toBe(GATE_A)
  })

  it('parseGate reads all gate fields with correct types', () => {
    const g = parseGate(gateObj(GATE_A), PKG)
    expect(g).toEqual({
      gateId: GATE_A,
      priceMist: 1000n,
      paymentRecipient: RECIPIENT,
      defaultUses: 3n,
      soulbound: true,
      autoBurnAtZero: false,
      paused: false,
      frozen: false,
      nftName: 'Test Pass',
      nftImageUrl: 'https://x/y.png',
      nftDescription: 'desc',
      policy: { freezeRequiresUnpaused: false, lockCommissionOnFreeze: false, pauseBlocksDecryption: false, pauseBlocksAccess: false },
      lockedCommission: null,
      freeFeePaid: false,
    })
  })

  it('parseGate reads a gate policy, locked commission terms and the free-fee flag', () => {
    const g = parseGate(
      gateObj(GATE_A, {
        frozen: true,
        policy: { freeze_requires_unpaused: true, lock_commission_on_freeze: true, pause_blocks_decryption: false, pause_blocks_access: true },
        locked_commission: { bps: '20', min_mist: '1000000' },
        free_fee_paid: true,
      }),
      PKG,
    )
    expect(g?.policy).toEqual({ freezeRequiresUnpaused: true, lockCommissionOnFreeze: true, pauseBlocksDecryption: false, pauseBlocksAccess: true })
    expect(g?.lockedCommission).toEqual({ bps: 20n, minMist: 1_000_000n })
    expect(g?.freeFeePaid).toBe(true)
  })

  it('parseGate accepts the JSON-RPC Option shape for locked_commission', () => {
    const vec = { vec: [{ fields: { bps: '30', min_mist: '5' } }] }
    expect(parseGate(gateObj(GATE_A, { locked_commission: vec }), PKG)?.lockedCommission).toEqual({ bps: 30n, minMist: 5n })
    expect(parseGate(gateObj(GATE_A, { locked_commission: { vec: [] } }), PKG)?.lockedCommission).toBeNull()
  })

  it('parseGate treats a missing locked_commission key as malformed, never as "no lock"', () => {
    const obj = gateObj(GATE_A, {})
    const data = (obj as { json: Record<string, unknown> }).json
    expect(parseGate(obj, PKG)?.lockedCommission).toBeNull() // explicit null is "none"
    delete data.locked_commission
    expect(parseGate(obj, PKG)).toBeNull()
  })

  it('parseGate returns null when fields are missing', () => {
    expect(parseGate({ objectId: GATE_A, type: GATE_TYPE }, PKG)).toBeNull()
  })

  it('parseGate never invents a value for a missing or mistyped field', () => {
    // A missing price must not read as a free gate.
    const { price_mist: _p, ...noPrice } = gateObj(GATE_A).json!
    expect(parseGate({ ...gateObj(GATE_A), json: noPrice }, PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { paused: 'false' }), PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { price_mist: '-1' }), PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { price_mist: '18446744073709551616' }), PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { payment_recipient: 'nobody' }), PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { policy: undefined }), PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { policy: { ...NO_POLICY, pause_blocks_access: 1 } }), PKG)).toBeNull()
    expect(parseGate(gateObj(GATE_A, { locked_commission: { bps: '1' } }), PKG)).toBeNull()
  })

  it('parseGate and parseAdminCap return normalised ids', () => {
    expect(parseGate(gateObj('0xA'), PKG)?.gateId).toBe(GATE_A)
    expect(parseGate(gateObj(GATE_A, { payment_recipient: '0xE1' }), PKG)?.paymentRecipient).toBe(RECIPIENT)
    expect(parseAdminCap(capObj('0xCA', '0xa'), PKG)).toEqual({ adminCapId: CAP_A, gateId: GATE_A })
  })

  it('fetchAdminCaps reads every page of the normalised AdminCap type', async () => {
    const listOwnedObjects = vi.fn(async ({ cursor }: { cursor?: string | null }) =>
      cursor
        ? { objects: [capObj(CAP_B, GATE_B)], hasNextPage: false, cursor: null }
        : { objects: [capObj(CAP_A, GATE_A)], hasNextPage: true, cursor: 'p2' },
    )
    const client: OwnedObjectsClient = { core: { listOwnedObjects } }
    const caps = await fetchAdminCaps(client, '0xowner', PKG)
    expect(caps).toEqual([
      { adminCapId: CAP_A, gateId: GATE_A },
      { adminCapId: CAP_B, gateId: GATE_B },
    ])
    expect(listOwnedObjects).toHaveBeenCalledWith(
      expect.objectContaining({ owner: '0xowner', type: `${PKG_LONG}::access_gate::AdminCap`, include: { json: true } }),
    )
  })

  it('ownsPlatformAdminCap is true only for this package\'s cap', async () => {
    const holding = (type: string): OwnedObjectsClient => ({
      core: { listOwnedObjects: vi.fn(async () => ({ objects: [{ objectId: '0xp', type }], hasNextPage: false, cursor: null })) },
    })
    expect(await ownsPlatformAdminCap(holding(`${PKG}::access_gate::PlatformAdminCap`), '0xo', PKG)).toBe(true)
    expect(await ownsPlatformAdminCap(holding(`${LOOKALIKE}::access_gate::PlatformAdminCap`), '0xo', PKG)).toBe(false)
  })

  it('fetchGate does a typed getObject and parses it', async () => {
    const getObject = vi.fn(async () => ({ object: gateObj(GATE_A) }))
    const client: SuiObjectClient = { core: { getObject } }
    const g = await fetchGate(client, GATE_A, PKG)
    expect(g?.gateId).toBe(GATE_A)
    expect(g?.frozen).toBe(false)
    expect(getObject).toHaveBeenCalledWith(
      expect.objectContaining({ objectId: GATE_A, include: { json: true } }),
    )
  })

  it('fetchOwnedGates composes caps → gates and merges adminCapId', async () => {
    const client: OwnedObjectsClient & SuiObjectClient = {
      core: {
        listOwnedObjects: vi.fn(async () => ({
          objects: [capObj(CAP_A, GATE_A), capObj(CAP_B, GATE_B)],
          hasNextPage: false,
          cursor: null,
        })),
        getObject: vi.fn(async ({ objectId }: { objectId: string }) => ({
          object: objectId === GATE_A ? gateObj(GATE_A) : gateObj(GATE_B, { paused: true, frozen: true }),
        })),
      },
    }
    const gates = await fetchOwnedGates(client, '0xowner', PKG)
    expect(gates).toHaveLength(2)
    const a = gates.find((g) => g.gateId === GATE_A)!
    const b = gates.find((g) => g.gateId === GATE_B)!
    expect(a.adminCapId).toBe(CAP_A)
    expect(b.adminCapId).toBe(CAP_B)
    expect(b.paused).toBe(true)
    expect(b.frozen).toBe(true)
  })

  it('fetchOwnedGates skips a cap whose gate id is not a Gate', async () => {
    const client: OwnedObjectsClient & SuiObjectClient = {
      core: {
        listOwnedObjects: vi.fn(async () => ({ objects: [capObj(CAP_A, GATE_A)], hasNextPage: false, cursor: null })),
        getObject: vi.fn(async () => ({ object: { objectId: GATE_A, type: '0x2::coin::Coin<0x2::sui::SUI>' } as CoreObject })),
      },
    }
    expect(await fetchOwnedGates(client, '0xowner', PKG)).toEqual([])
  })
})

describe('PlatformConfig commission', () => {
  const cfgObj: CoreObject = {
    objectId: id('cf'),
    type: `${PKG}::access_gate::PlatformConfig`,
    json: {
      id: { id: id('cf') },
      version: '1',
      treasury: TREASURY,
      commission_bps: '20',
      min_commission_mist: '1000000',
      free_gate_fee_mist: '100000000',
    },
  }

  it('parsePlatformConfig reads treasury, commission terms and free-gate fee (bare or { object })', () => {
    const want = { version: 1n, treasury: TREASURY, commissionBps: 20n, minCommissionMist: 1_000_000n, freeGateFeeMist: 100_000_000n }
    expect(parsePlatformConfig(cfgObj, PKG)).toEqual(want)
    // Every deployment is version-gated: a config without `version` is malformed.
    const { version: _v, ...preGating } = cfgObj.json!
    expect(parsePlatformConfig({ ...cfgObj, json: preGating }, PKG)).toBeNull()
    expect(parsePlatformConfig({ ...cfgObj, json: { ...cfgObj.json, commission_bps: 'x' } }, PKG)).toBeNull()
    expect(parsePlatformConfig({ object: cfgObj }, PKG)).toEqual(want)
    expect(parsePlatformConfig({ objectId: id('cf'), type: cfgObj.type }, PKG)).toBeNull()
    expect(parsePlatformConfig({ ...cfgObj, type: `${LOOKALIKE}::access_gate::PlatformConfig` }, PKG)).toBeNull()
    const { free_gate_fee_mist: _omit, ...partial } = cfgObj.json!
    expect(parsePlatformConfig({ ...cfgObj, json: partial }, PKG)).toBeNull()
  })

  it('fetchPlatformConfig requests json for the given object', async () => {
    const getObject = vi.fn(async () => ({ object: cfgObj }))
    const res = await fetchPlatformConfig({ core: { getObject } }, id('cf'), PKG)
    expect(getObject).toHaveBeenCalledWith({ objectId: id('cf'), include: { json: true } })
    expect(res.commissionBps).toBe(20n)
  })

  it('fetchPlatformConfig throws for an object that is not this package\'s PlatformConfig', async () => {
    const getObject = vi.fn(async () => ({ object: { ...cfgObj, type: `${LOOKALIKE}::access_gate::PlatformConfig` } }))
    await expect(fetchPlatformConfig({ core: { getObject } }, '0xcfg', PKG)).rejects.toThrow(/not an access_gate PlatformConfig/)
  })
})
