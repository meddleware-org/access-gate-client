import { describe, it, expect } from 'vitest'
import { bcs } from '@mysten/sui/bcs'
import { toBase64 } from '@mysten/sui/utils'
import {
  buildPurchaseTx,
  buildConsumeTx,
  buildCreateGateTx,
  buildSetPriceTx,
  buildSetPaymentRecipientTx,
  buildSetPausedTx,
  buildSetDefaultUsesTx,
  buildSetSoulboundTx,
  buildSetAutoBurnAtZeroTx,
  buildSetNftNameTx,
  buildSetNftImageUrlTx,
  buildSetNftDescriptionTx,
  buildAirdropTx,
  buildMakeGateImmutableTx,
  buildMakeGateFreeTx,
  DEFAULT_GATE_POLICY,
  isRestrictivePolicy,
  commissionForPrice,
  minimumPaidPriceMist,
  gateCommissionMist,
} from '../src/ptb.js'
import type { AccessGateConfig, GateAdminContext } from '../src/types.js'

// Valid 32-byte hex addresses (moveCall/object validate their inputs).
const PKG = '0x00000000000000000000000000000000000000000000000000000000000000aa'
const GATE = '0x00000000000000000000000000000000000000000000000000000000000000a1'
const PLATFORM = '0x00000000000000000000000000000000000000000000000000000000000000a2'
const NFT = '0x00000000000000000000000000000000000000000000000000000000000000b2'
const RECIPIENT = '0x00000000000000000000000000000000000000000000000000000000000000c3'

const cfg: AccessGateConfig = {
  packageId: PKG,
  gateId: GATE,
  platformConfigId: PLATFORM,
  nftType: `${PKG}::access_gate::AccessNFT`,
  soulbound: false,
}

function commandsJson(tx: { getData: () => unknown }): string {
  return JSON.stringify(tx.getData())
}

describe('ptb builders', () => {
  it('buildPurchaseTx targets access_gate::purchase and splits gas', () => {
    const json = commandsJson(buildPurchaseTx(cfg, 500n))
    expect(json).toContain('"function":"purchase"')
    expect(json).toContain('"module":"access_gate"')
    expect(json).toContain('SplitCoins')
    // gate, platformConfig, payment — three args
    expect(json).toContain(GATE.slice(2))
    expect(json).toContain(PLATFORM.slice(2))
  })

  it('buildConsumeTx targets consume for transferable gates', () => {
    const json = commandsJson(buildConsumeTx(cfg, NFT, 'nonce-1'))
    expect(json).toContain('"function":"consume"')
    expect(json).not.toContain('consume_soulbound')
  })

  it('buildConsumeTx targets consume_soulbound for soulbound gates', () => {
    const json = commandsJson(buildConsumeTx({ ...cfg, soulbound: true }, NFT, 'nonce-1'))
    expect(json).toContain('"function":"consume_soulbound"')
  })

  const gateOpts = {
    priceMist: 10_000_000n,
    paymentRecipient: RECIPIENT,
    defaultUses: 1n,
    soulbound: false,
    autoBurnAtZero: true,
    nftName: 'Pass',
    nftImageUrl: 'https://example.com/i.png',
    nftDescription: 'd',
  }

  it('buildCreateGateTx: paid gate → new_gate_policy + create_gate(platform, price, …, policy)', () => {
    const json = commandsJson(buildCreateGateTx(PKG, PLATFORM, gateOpts))
    expect(json).toContain('"function":"new_gate_policy"')
    expect(json).toContain('"function":"create_gate"')
    expect(json).not.toContain('create_free_gate')
    expect(json).not.toContain('SplitCoins')
    expect(json).toContain(PLATFORM.slice(2))
    // 4 policy flags + platform + price + 7 gate values; the policy is command 0's result.
    expect((json.match(/"Input":\d+/g) ?? []).length).toBe(13)
    expect(json).toContain('"NestedResult":[0,0]')
  })

  it('buildCreateGateTx: price 0 → splits the free-gate fee and calls create_free_gate', () => {
    const json = commandsJson(buildCreateGateTx(PKG, PLATFORM, { ...gateOpts, priceMist: 0n, freeGateFeeMist: 100_000_000n }))
    expect(json).toContain('"function":"create_free_gate"')
    expect(json).toContain('SplitCoins')
    expect(json).not.toContain('"function":"create_gate"')
  })

  it('buildCreateGateTx: price 0 without freeGateFeeMist throws', () => {
    expect(() => buildCreateGateTx(PKG, PLATFORM, { ...gateOpts, priceMist: 0n })).toThrow(/freeGateFeeMist/)
  })

  it('buildCreateGateTx passes the policy flags through', () => {
    const tx = buildCreateGateTx(PKG, PLATFORM, {
      ...gateOpts,
      policy: { freezeRequiresUnpaused: true, lockCommissionOnFreeze: false, pauseBlocksDecryption: true, pauseBlocksAccess: true },
    })
    const data = tx.getData() as { inputs: Array<{ Pure?: { bytes: string } }> }
    // The first four inputs are the policy bools, in order: true, false, true, true (BCS 1/0).
    expect(data.inputs.slice(0, 4).map((i) => i.Pure?.bytes)).toEqual(['AQ==', 'AA==', 'AQ==', 'AQ=='])
  })
})

describe('policy + commission helpers', () => {
  it('isRestrictivePolicy is false only for the all-false policy', () => {
    expect(isRestrictivePolicy(DEFAULT_GATE_POLICY)).toBe(false)
    expect(isRestrictivePolicy({ ...DEFAULT_GATE_POLICY, pauseBlocksAccess: true })).toBe(true)
  })

  const terms = { bps: 20n, minMist: 1_000_000n }

  it('commissionForPrice mirrors the contract: max(bps share, floor), capped at 10%', () => {
    expect(commissionForPrice(0n, terms)).toBe(0n)
    expect(commissionForPrice(10_000_000n, terms)).toBe(1_000_000n) // floor
    expect(commissionForPrice(5_000_000n, terms)).toBe(500_000n) // capped at 10%
    expect(commissionForPrice(1_000_000_000n, terms)).toBe(2_000_000n) // 0.2%
    expect(commissionForPrice(499n, { bps: 20n, minMist: 0n })).toBe(0n) // dust without a floor
  })

  it('minimumPaidPriceMist is 10 × the floor (at least 1)', () => {
    expect(minimumPaidPriceMist(0n)).toBe(1n)
    expect(minimumPaidPriceMist(1n)).toBe(10n)
    expect(minimumPaidPriceMist(1_000_000n)).toBe(10_000_000n)
    expect(commissionForPrice(minimumPaidPriceMist(1_000_000n), terms)).toBe(1_000_000n)
  })

  it('gateCommissionMist prefers the gate’s locked terms over the live platform terms', () => {
    const platform = { treasury: '0x1', commissionBps: 20n, minCommissionMist: 5_000_000n, freeGateFeeMist: 0n }
    expect(gateCommissionMist({ priceMist: 100_000_000n, lockedCommission: null }, platform)).toBe(5_000_000n)
    expect(gateCommissionMist({ priceMist: 100_000_000n, lockedCommission: terms }, platform)).toBe(1_000_000n)
  })
})

const ADMIN_CAP = '0x00000000000000000000000000000000000000000000000000000000000000d4'
const adminCtx: GateAdminContext = { packageId: PKG, gateId: GATE, adminCapId: ADMIN_CAP, platformConfigId: PLATFORM }

describe('gate-admin PTB builders', () => {
  // Each admin builder must call the named entry with [adminCap, gate, ...] as the first two args.
  const cases: Array<{ name: string; fn: string; tx: () => { getData: () => unknown }; inputs: number }> = [
    { name: 'buildSetPriceTx', fn: 'set_price', tx: () => buildSetPriceTx(adminCtx, 10_000_000n), inputs: 4 },
    { name: 'buildSetPaymentRecipientTx', fn: 'set_payment_recipient', tx: () => buildSetPaymentRecipientTx(adminCtx, RECIPIENT), inputs: 3 },
    { name: 'buildSetPausedTx', fn: 'set_paused', tx: () => buildSetPausedTx(adminCtx, true), inputs: 3 },
    { name: 'buildSetDefaultUsesTx', fn: 'set_default_uses', tx: () => buildSetDefaultUsesTx(adminCtx, 5n), inputs: 3 },
    { name: 'buildSetSoulboundTx', fn: 'set_soulbound', tx: () => buildSetSoulboundTx(adminCtx, true), inputs: 3 },
    { name: 'buildSetAutoBurnAtZeroTx', fn: 'set_auto_burn_at_zero', tx: () => buildSetAutoBurnAtZeroTx(adminCtx, false), inputs: 3 },
    { name: 'buildSetNftNameTx', fn: 'set_nft_name', tx: () => buildSetNftNameTx(adminCtx, 'Name'), inputs: 3 },
    { name: 'buildSetNftImageUrlTx', fn: 'set_nft_image_url', tx: () => buildSetNftImageUrlTx(adminCtx, 'https://x/y.png'), inputs: 3 },
    { name: 'buildSetNftDescriptionTx', fn: 'set_nft_description', tx: () => buildSetNftDescriptionTx(adminCtx, 'desc'), inputs: 3 },
    { name: 'buildAirdropTx', fn: 'airdrop', tx: () => buildAirdropTx(adminCtx, RECIPIENT, 1_000_000n), inputs: 5 },
    { name: 'buildMakeGateFreeTx', fn: 'make_gate_free', tx: () => buildMakeGateFreeTx(adminCtx, 100_000_000n), inputs: 4 },
    { name: 'buildMakeGateImmutableTx', fn: 'make_gate_immutable', tx: () => buildMakeGateImmutableTx(adminCtx), inputs: 3 },
  ]

  for (const c of cases) {
    it(`${c.name} targets access_gate::${c.fn} with cap + gate + ${c.inputs - 2} value(s)`, () => {
      const json = commandsJson(c.tx())
      expect(json).toContain(`"function":"${c.fn}"`)
      expect(json).toContain('"module":"access_gate"')
      // adminCap + gate are always present
      expect(json).toContain(ADMIN_CAP.slice(2))
      expect(json).toContain(GATE.slice(2))
      const inputRefs = json.match(/"Input":\d+/g) ?? []
      expect(inputRefs.length).toBe(c.inputs)
    })
  }

  it('builders that read PlatformConfig pass it', () => {
    for (const tx of [buildSetPriceTx(adminCtx, 10_000_000n), buildAirdropTx(adminCtx, RECIPIENT, 0n), buildMakeGateFreeTx(adminCtx, 0n), buildMakeGateImmutableTx(adminCtx)]) {
      expect(commandsJson(tx)).toContain(PLATFORM.slice(2))
    }
  })
})

// ── Exact argument values and order ──────────────────────────────────────────────
// Each move-call argument is resolved to `obj:<id>`, `pure:<base64 BCS>`, `result:<cmd>` or
// `gas`, so a swapped or mis-typed argument fails here instead of aborting on-chain.
type TxData = {
  inputs: Array<{ UnresolvedObject?: { objectId: string }; Object?: unknown; Pure?: { bytes: string } }>
  commands: Array<{ MoveCall?: { function: string; arguments: Array<Record<string, unknown>> } }>
}

function callArgs(tx: { getData: () => unknown }, fn: string): string[] {
  const data = tx.getData() as TxData
  const call = data.commands.find((c) => c.MoveCall?.function === fn)?.MoveCall
  if (!call) throw new Error(`no move call ${fn}`)
  return call.arguments.map((a) => {
    if (typeof a.Input === 'number') {
      const input = data.inputs[a.Input]
      if (input.UnresolvedObject) return `obj:${input.UnresolvedObject.objectId}`
      if (input.Pure) return `pure:${input.Pure.bytes}`
      return 'input:?'
    }
    if (Array.isArray(a.NestedResult)) return `result:${(a.NestedResult as number[])[0]}`
    if (typeof a.Result === 'number') return `result:${a.Result}`
    if (a.GasCoin) return 'gas'
    return JSON.stringify(a)
  })
}

const u64 = (v: bigint) => `pure:${toBase64(bcs.u64().serialize(v).toBytes())}`
const bool = (v: boolean) => `pure:${toBase64(bcs.bool().serialize(v).toBytes())}`
const str = (v: string) => `pure:${toBase64(bcs.string().serialize(v).toBytes())}`
const addr = (v: string) => `pure:${toBase64(bcs.Address.serialize(v).toBytes())}`
const bytes = (v: string) => `pure:${toBase64(bcs.vector(bcs.u8()).serialize(new TextEncoder().encode(v)).toBytes())}`

describe('ptb builders — exact arguments', () => {
  it('purchase(gate, platformConfig, payment split from gas)', () => {
    const tx = buildPurchaseTx(cfg, 500n)
    expect(callArgs(tx, 'purchase')).toEqual([`obj:${GATE}`, `obj:${PLATFORM}`, 'result:0'])
  })

  it('consume(nft, gate, nonce bytes) and the soulbound variant', () => {
    const expected = [`obj:${NFT}`, `obj:${GATE}`, bytes('nonce-1')]
    expect(callArgs(buildConsumeTx(cfg, NFT, 'nonce-1'), 'consume')).toEqual(expected)
    expect(callArgs(buildConsumeTx({ ...cfg, soulbound: true }, NFT, 'nonce-1'), 'consume_soulbound')).toEqual(expected)
  })

  it('create_gate(platform, price, recipient, uses, soulbound, autoBurn, name, image, description, policy)', () => {
    const tx = buildCreateGateTx(PKG, PLATFORM, {
      priceMist: 10_000_000n,
      paymentRecipient: RECIPIENT,
      defaultUses: 3n,
      soulbound: true,
      autoBurnAtZero: false,
      nftName: 'Pass',
      nftImageUrl: 'https://example.com/i.png',
      nftDescription: 'd',
    })
    expect(callArgs(tx, 'new_gate_policy')).toEqual([bool(false), bool(false), bool(false), bool(false)])
    expect(callArgs(tx, 'create_gate')).toEqual([
      `obj:${PLATFORM}`,
      u64(10_000_000n),
      addr(RECIPIENT),
      u64(3n),
      bool(true),
      bool(false),
      str('Pass'),
      str('https://example.com/i.png'),
      str('d'),
      'result:0',
    ])
  })

  it('create_free_gate(platform, fee, …) takes the split fee coin second', () => {
    const tx = buildCreateGateTx(PKG, PLATFORM, {
      priceMist: 0n,
      freeGateFeeMist: 100_000_000n,
      paymentRecipient: RECIPIENT,
      defaultUses: 1n,
      soulbound: false,
      autoBurnAtZero: true,
      nftName: 'n',
      nftImageUrl: 'u',
      nftDescription: 'd',
    })
    const args = callArgs(tx, 'create_free_gate')
    expect(args.slice(0, 3)).toEqual([`obj:${PLATFORM}`, 'result:1', addr(RECIPIENT)])
    expect(args).toHaveLength(10)
  })

  it('admin setters pass (cap, gate, value) in order', () => {
    const head = [`obj:${ADMIN_CAP}`, `obj:${GATE}`]
    expect(callArgs(buildSetPriceTx(adminCtx, 7n), 'set_price')).toEqual([...head, `obj:${PLATFORM}`, u64(7n)])
    expect(callArgs(buildSetPaymentRecipientTx(adminCtx, RECIPIENT), 'set_payment_recipient')).toEqual([...head, addr(RECIPIENT)])
    expect(callArgs(buildSetPausedTx(adminCtx, true), 'set_paused')).toEqual([...head, bool(true)])
    expect(callArgs(buildSetDefaultUsesTx(adminCtx, 9n), 'set_default_uses')).toEqual([...head, u64(9n)])
    expect(callArgs(buildSetSoulboundTx(adminCtx, false), 'set_soulbound')).toEqual([...head, bool(false)])
    expect(callArgs(buildSetAutoBurnAtZeroTx(adminCtx, true), 'set_auto_burn_at_zero')).toEqual([...head, bool(true)])
    expect(callArgs(buildSetNftNameTx(adminCtx, 'N'), 'set_nft_name')).toEqual([...head, str('N')])
    expect(callArgs(buildSetNftImageUrlTx(adminCtx, 'https://x/y.png'), 'set_nft_image_url')).toEqual([...head, str('https://x/y.png')])
    expect(callArgs(buildSetNftDescriptionTx(adminCtx, 'D'), 'set_nft_description')).toEqual([...head, str('D')])
    expect(callArgs(buildMakeGateImmutableTx(adminCtx), 'make_gate_immutable')).toEqual([...head, `obj:${PLATFORM}`])
    expect(callArgs(buildMakeGateFreeTx(adminCtx, 5n), 'make_gate_free')).toEqual([...head, `obj:${PLATFORM}`, 'result:0'])
  })

  it('airdrop(cap, gate, platform, commission, recipient)', () => {
    expect(callArgs(buildAirdropTx(adminCtx, RECIPIENT, 1_000_000n), 'airdrop')).toEqual([
      `obj:${ADMIN_CAP}`,
      `obj:${GATE}`,
      `obj:${PLATFORM}`,
      'result:0',
      addr(RECIPIENT),
    ])
  })
})
