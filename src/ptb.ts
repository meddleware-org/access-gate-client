import { Transaction } from '@mysten/sui/transactions'
import type { AccessGateConfig, CommissionTerms, GateAdminContext, GatePolicy, OwnedGate, PlatformConfigInfo } from './types.js'

/** The unrestricted policy — every restriction off (`default_gate_policy` on-chain). */
export const DEFAULT_GATE_POLICY: Readonly<GatePolicy> = Object.freeze({
  freezeRequiresUnpaused: false,
  lockCommissionOnFreeze: false,
  pauseBlocksDecryption: false,
  pauseBlocksAccess: false,
})

/** True if `policy` enables any restriction. */
export function isRestrictivePolicy(policy: GatePolicy): boolean {
  return (
    policy.freezeRequiresUnpaused ||
    policy.lockCommissionOnFreeze ||
    policy.pauseBlocksDecryption ||
    policy.pauseBlocksAccess
  )
}

/**
 * Build a PTB that purchases access: split `priceMist` from the gas coin and call
 * `access_gate::purchase(gate, payment)`. Overpayment is refunded on-chain, so the split
 * must be exactly the price. The caller signs + executes with their wallet.
 */
export function buildPurchaseTx(cfg: AccessGateConfig, priceMist: bigint | number): Transaction {
  const tx = new Transaction()
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(priceMist)])
  tx.moveCall({
    target: `${cfg.packageId}::access_gate::purchase`,
    arguments: [tx.object(cfg.gateId), tx.object(cfg.platformConfigId), payment],
  })
  return tx
}

/**
 * Build a PTB that consumes one use of a single-use NFT, binding it to `nonce`. Selects
 * `consume` or `consume_soulbound` from `cfg.soulbound`. For unlimited passes there is
 * nothing to consume — do not call this.
 */
export function buildConsumeTx(
  cfg: AccessGateConfig,
  nftId: string,
  nonce: string,
): Transaction {
  const tx = new Transaction()
  const fn = cfg.soulbound ? 'consume_soulbound' : 'consume'
  const nonceBytes = Array.from(new TextEncoder().encode(nonce))
  tx.moveCall({
    target: `${cfg.packageId}::access_gate::${fn}`,
    arguments: [tx.object(nftId), tx.object(cfg.gateId), tx.pure.vector('u8', nonceBytes)],
  })
  return tx
}

/**
 * Build a PTB that creates a new gate with an immutable `policy` (default: unrestricted).
 * `packageId` is the call target (latest published-at).
 *
 * - `priceMist > 0` calls `create_gate`; the price must be at least the platform's
 *   `minimumPaidPriceMist` or the call aborts (`E_PRICE_TOO_LOW`, 11).
 * - `priceMist == 0` calls `create_free_gate`, paying `freeGateFeeMist` (the platform's current
 *   `free_gate_fee_mist`, from `fetchPlatformConfig`) out of gas; an excess is refunded on-chain.
 */
export function buildCreateGateTx(
  packageId: string,
  platformConfigId: string,
  opts: {
    priceMist: bigint | number
    paymentRecipient: string
    defaultUses: bigint | number
    soulbound: boolean
    autoBurnAtZero: boolean
    nftName: string
    nftImageUrl: string
    nftDescription: string
    /** Immutable restrictions for this gate; omit for the unrestricted default. */
    policy?: GatePolicy
    /** Required when `priceMist` is 0: the free-gate fee to pay. */
    freeGateFeeMist?: bigint | number
  },
): Transaction {
  const tx = new Transaction()
  const p = opts.policy ?? DEFAULT_GATE_POLICY
  const [policy] = tx.moveCall({
    target: `${packageId}::access_gate::new_gate_policy`,
    arguments: [
      tx.pure.bool(p.freezeRequiresUnpaused),
      tx.pure.bool(p.lockCommissionOnFreeze),
      tx.pure.bool(p.pauseBlocksDecryption),
      tx.pure.bool(p.pauseBlocksAccess),
    ],
  })
  const tail = [
    tx.pure.address(opts.paymentRecipient),
    tx.pure.u64(opts.defaultUses),
    tx.pure.bool(opts.soulbound),
    tx.pure.bool(opts.autoBurnAtZero),
    tx.pure.string(opts.nftName),
    tx.pure.string(opts.nftImageUrl),
    tx.pure.string(opts.nftDescription),
    policy,
  ]
  if (BigInt(opts.priceMist) === 0n) {
    if (opts.freeGateFeeMist === undefined) throw new Error('freeGateFeeMist is required for a free gate')
    const [fee] = tx.splitCoins(tx.gas, [tx.pure.u64(opts.freeGateFeeMist)])
    tx.moveCall({
      target: `${packageId}::access_gate::create_free_gate`,
      arguments: [tx.object(platformConfigId), fee, ...tail],
    })
  } else {
    tx.moveCall({
      target: `${packageId}::access_gate::create_gate`,
      arguments: [tx.object(platformConfigId), tx.pure.u64(opts.priceMist), ...tail],
    })
  }
  return tx
}

// ── Gate administration (AdminCap-gated) ─────────────────────────────────────────
// Builders for the operator management surface. Each calls an `assert_admin`-gated entry
// point with `[adminCap, gate, <value>]`; the operator signs + executes with their wallet.
// The on-chain call aborts (`E_WRONG_GATE` / `E_FROZEN`) if the cap/gate mismatch or the
// gate is frozen, so these never need to pre-check.

/** The element type accepted by a `moveCall`'s `arguments` array. */
type MoveCallArg = NonNullable<Parameters<Transaction['moveCall']>[0]['arguments']>[number]

/** Build a single-`moveCall` admin PTB: `<fn>(adminCap, gate, ...extraArgs)`. */
function buildGateAdminCall(
  ctx: GateAdminContext,
  fn: string,
  extraArgs: (tx: Transaction) => MoveCallArg[],
): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${ctx.packageId}::access_gate::${fn}`,
    arguments: [tx.object(ctx.adminCapId), tx.object(ctx.gateId), ...extraArgs(tx)],
  })
  return tx
}

/**
 * Set the gate price (in MIST) for future purchases. A paid price must be at least the platform's
 * minimum (`E_PRICE_TOO_LOW`, 11); 0 only once the free-gate fee is paid (`E_FREE_FEE_UNPAID`, 12 —
 * use `buildMakeGateFreeTx`).
 */
export function buildSetPriceTx(ctx: GateAdminContext, priceMist: bigint | number): Transaction {
  return buildGateAdminCall(ctx, 'set_price', (tx) => [tx.object(ctx.platformConfigId), tx.pure.u64(priceMist)])
}

/**
 * Make the gate free (price 0), paying `feeMist` from gas — the platform's `free_gate_fee_mist`, or
 * 0 if this gate already paid it (`OwnedGate.freeFeePaid`). Any excess is refunded on-chain.
 */
export function buildMakeGateFreeTx(ctx: GateAdminContext, feeMist: bigint | number): Transaction {
  const tx = new Transaction()
  const [fee] = tx.splitCoins(tx.gas, [tx.pure.u64(feeMist)])
  tx.moveCall({
    target: `${ctx.packageId}::access_gate::make_gate_free`,
    arguments: [tx.object(ctx.adminCapId), tx.object(ctx.gateId), tx.object(ctx.platformConfigId), fee],
  })
  return tx
}

/** Redirect future purchase payments to a new recipient address. */
export function buildSetPaymentRecipientTx(ctx: GateAdminContext, recipient: string): Transaction {
  return buildGateAdminCall(ctx, 'set_payment_recipient', (tx) => [tx.pure.address(recipient)])
}

/** Pause or unpause `purchase` (paused ⇒ `purchase` aborts with `E_PAUSED`). */
export function buildSetPausedTx(ctx: GateAdminContext, paused: boolean): Transaction {
  return buildGateAdminCall(ctx, 'set_paused', (tx) => [tx.pure.bool(paused)])
}

/** Change the default uses for future mints (0 ⇒ unlimited pass; N ⇒ single-use with N). */
export function buildSetDefaultUsesTx(ctx: GateAdminContext, defaultUses: bigint | number): Transaction {
  return buildGateAdminCall(ctx, 'set_default_uses', (tx) => [tx.pure.u64(defaultUses)])
}

/** Switch the soulbound flag for future mints (does not affect already-minted NFTs). */
export function buildSetSoulboundTx(ctx: GateAdminContext, soulbound: boolean): Transaction {
  return buildGateAdminCall(ctx, 'set_soulbound', (tx) => [tx.pure.bool(soulbound)])
}

/** Toggle the auto-burn-at-zero policy for future mints. */
export function buildSetAutoBurnAtZeroTx(ctx: GateAdminContext, autoBurn: boolean): Transaction {
  return buildGateAdminCall(ctx, 'set_auto_burn_at_zero', (tx) => [tx.pure.bool(autoBurn)])
}

/** Update the default NFT display name for future mints. */
export function buildSetNftNameTx(ctx: GateAdminContext, name: string): Transaction {
  return buildGateAdminCall(ctx, 'set_nft_name', (tx) => [tx.pure.string(name)])
}

/** Update the default NFT image URL for future mints. */
export function buildSetNftImageUrlTx(ctx: GateAdminContext, url: string): Transaction {
  return buildGateAdminCall(ctx, 'set_nft_image_url', (tx) => [tx.pure.string(url)])
}

/** Update the default NFT description for future mints. */
export function buildSetNftDescriptionTx(ctx: GateAdminContext, description: string): Transaction {
  return buildGateAdminCall(ctx, 'set_nft_description', (tx) => [tx.pure.string(description)])
}

/**
 * AdminCap-gated grant (airdrop) of the gate's NFT flavour to `recipient`. The admin pays the
 * platform the commission a purchase would carry (`gateCommissionMist`; 0 for a free gate), split
 * from gas as `commissionMist`; any excess is refunded on-chain.
 */
export function buildAirdropTx(
  ctx: GateAdminContext,
  recipient: string,
  commissionMist: bigint | number,
): Transaction {
  const tx = new Transaction()
  const [payment] = tx.splitCoins(tx.gas, [tx.pure.u64(commissionMist)])
  tx.moveCall({
    target: `${ctx.packageId}::access_gate::airdrop`,
    arguments: [
      tx.object(ctx.adminCapId),
      tx.object(ctx.gateId),
      tx.object(ctx.platformConfigId),
      payment,
      tx.pure.address(recipient),
    ],
  })
  return tx
}

/**
 * Make the gate immutable — **irreversible**. Consumes the `AdminCap` (passed by value) and sets
 * `Gate.frozen = true`, permanently ending all setters and `airdrop`. `purchase`/`consume` remain
 * permissionless. Grant everything first, then freeze.
 *
 * Reads the shared `PlatformConfig` (the commission snapshot for gates whose policy has
 * `lockCommissionOnFreeze`). Aborts `E_FREEZE_WHILE_PAUSED` (10) if the gate is paused and its
 * policy has `freezeRequiresUnpaused`.
 */
export function buildMakeGateImmutableTx(ctx: GateAdminContext): Transaction {
  const tx = new Transaction()
  tx.moveCall({
    target: `${ctx.packageId}::access_gate::make_gate_immutable`,
    // cap is consumed by value; gate is &mut; platform is read for the commission snapshot.
    arguments: [tx.object(ctx.adminCapId), tx.object(ctx.gateId), tx.object(ctx.platformConfigId)],
  })
  return tx
}

// ── Commission helpers (read-only arithmetic mirroring the contract) ──────────────────────────

/** Basis-point denominator used by `access_gate` commission maths. */
export const BPS_DENOMINATOR = 10_000n
/** The contract's hard cap on commission, in basis points (10% of the price). */
export const MAX_COMMISSION_BPS = 1_000n

/** The platform's current commission terms. */
export function platformCommissionTerms(platform: PlatformConfigInfo): CommissionTerms {
  return { bps: platform.commissionBps, minMist: platform.minCommissionMist }
}

/**
 * Commission (MIST) on `priceMist` under `terms`, exactly as the contract computes it:
 * `max(price × bps / 10000, minMist)` (percentage rounded down), never more than 10% of the price;
 * 0 for a price of 0.
 */
export function commissionForPrice(priceMist: bigint | number, terms: CommissionTerms): bigint {
  const price = BigInt(priceMist)
  if (price === 0n) return 0n
  const share = (price * terms.bps) / BPS_DENOMINATOR
  const cap = (price * MAX_COMMISSION_BPS) / BPS_DENOMINATOR
  const commission = share > terms.minMist ? share : terms.minMist
  return commission > cap ? cap : commission
}

/**
 * The lowest price a paid gate may have (`min_paid_price_mist` on-chain): 10 × the minimum
 * commission, so the floor never exceeds the 10% cap; at least 1 MIST.
 */
export function minimumPaidPriceMist(minCommissionMist: bigint | number): bigint {
  const min = (BigInt(minCommissionMist) * BPS_DENOMINATOR + MAX_COMMISSION_BPS - 1n) / MAX_COMMISSION_BPS
  return min === 0n ? 1n : min
}

/**
 * Commission a mint (purchase or airdrop) of `gate` pays now: under its freeze-time snapshot if it
 * locked one, otherwise under the live platform terms.
 */
export function gateCommissionMist(
  gate: Pick<OwnedGate, 'priceMist' | 'lockedCommission'>,
  platform: PlatformConfigInfo,
): bigint {
  return commissionForPrice(gate.priceMist, gate.lockedCommission ?? platformCommissionTerms(platform))
}
