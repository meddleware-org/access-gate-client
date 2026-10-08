import { Transaction } from '@mysten/sui/transactions'
import { parseStructTag } from '@mysten/sui/utils'
import type { TransactionResult } from '@mysten/sui/transactions'
import { normalizeAccessNftType } from './typeNames.js'
import type { AccessGateConfig, CommissionTerms, GateAdminContext, GatePolicy, OwnedGate, PlatformConfigInfo } from './types.js'

/** The unrestricted policy — every restriction off (`default_gate_policy` on-chain). */
export const DEFAULT_GATE_POLICY: Readonly<GatePolicy> = Object.freeze({
  freezeRequiresUnpaused: false,
  lockCommissionOnFreeze: false,
  pauseBlocksDecryption: false,
  pauseBlocksAccess: false,
})

const MAX_U64 = (1n << 64n) - 1n

/**
 * A u64 transaction argument from a bigint or a safe integer. A `number` above 2^53 has already
 * lost precision, so it is refused rather than encoded as a different amount.
 *
 * @throws {RangeError} if `v` is not an integer in `0..2^64-1`, or is an unsafe `number`.
 */
export function toU64(v: bigint | number): bigint {
  if (typeof v === 'number' && !Number.isSafeInteger(v)) {
    throw new RangeError(`not a safe integer amount: ${v} (pass a bigint)`)
  }
  const n = BigInt(v)
  if (n < 0n || n > MAX_U64) throw new RangeError(`out of u64 range: ${n}`)
  return n
}

/**
 * A recipient address in its full form, lowercased. `tx.pure.address` zero-pads short hex, so a
 * truncated paste (`0x12ab`) would silently become a different, unowned address; only `0x`
 * followed by 64 hex digits is accepted.
 *
 * @throws {Error} if `value` is not a full Sui address.
 */
export function toAddress(value: string): string {
  const v = value.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(v)) throw new Error(`not a full Sui address (0x followed by 64 hex digits): ${value}`)
  return v.toLowerCase()
}

/** The single result of a command that returns exactly one value. */
function only(result: TransactionResult): TransactionResult[number] {
  const [first] = result
  if (!first) throw new Error('expected a command result')
  return first
}

/** A coin of exactly `amount` MIST split from the gas coin. */
function splitFromGas(tx: Transaction, amount: bigint | number): TransactionResult[number] {
  return only(tx.splitCoins(tx.gas, [tx.pure.u64(toU64(amount))]))
}

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
 * `access_gate::purchase(gate, platformConfig, payment)`. Overpayment is refunded on-chain, so the
 * split must be exactly the price. The caller signs + executes with their wallet.
 */
export function buildPurchaseTx(cfg: AccessGateConfig, priceMist: bigint | number): Transaction {
  const tx = new Transaction()
  const payment = splitFromGas(tx, priceMist)
  tx.moveCall({
    target: `${cfg.packageId}::access_gate::purchase`,
    arguments: [tx.object(cfg.gateId), tx.object(cfg.platformConfigId), payment],
  })
  return tx
}

/** The contract's `MIN_NONCE_LENGTH`: a shorter nonce aborts `consume` with `E_INVALID_NONCE` (8). */
export const MIN_NONCE_BYTES = 8

/**
 * `consume` or `consume_soulbound`, derived from `cfg.nftType`. `cfg.soulbound`, when set, must agree:
 * a soulbound `nftType` with `soulbound` unset used to build the transferable `consume`, which aborts
 * on-chain after the user has paid.
 *
 * @throws {Error} if `nftType` is not an access NFT type, or `soulbound` disagrees with it.
 */
function consumeFunction(cfg: AccessGateConfig): 'consume' | 'consume_soulbound' {
  const soulboundType = parseStructTag(normalizeAccessNftType(cfg.nftType)).name === 'SoulboundAccessNFT'
  if (cfg.soulbound !== undefined && cfg.soulbound !== soulboundType) {
    throw new Error(`cfg.soulbound (${cfg.soulbound}) disagrees with cfg.nftType (${cfg.nftType})`)
  }
  return soulboundType ? 'consume_soulbound' : 'consume'
}

/**
 * Build a PTB that consumes one use of a single-use NFT, binding it to `nonce` (at least
 * {@link MIN_NONCE_BYTES} bytes). Selects `consume` or `consume_soulbound` from `cfg.nftType`. For unlimited passes there is
 * nothing to consume — do not call this. Reads the shared `PlatformConfig` (version gate).
 */
export function buildConsumeTx(
  cfg: AccessGateConfig,
  nftId: string,
  nonce: string,
): Transaction {
  const tx = new Transaction()
  const fn = consumeFunction(cfg)
  const nonceBytes = Array.from(new TextEncoder().encode(nonce))
  // The contract aborts with E_INVALID_NONCE after the user has signed and paid gas; refuse before the prompt.
  if (nonceBytes.length < MIN_NONCE_BYTES) {
    throw new RangeError(`nonce must be at least ${MIN_NONCE_BYTES} bytes (got ${nonceBytes.length})`)
  }
  tx.moveCall({
    target: `${cfg.packageId}::access_gate::${fn}`,
    arguments: [tx.object(nftId), tx.object(cfg.gateId), tx.object(cfg.platformConfigId), tx.pure.vector('u8', nonceBytes)],
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
  const policy = only(tx.moveCall({
    target: `${packageId}::access_gate::new_gate_policy`,
    arguments: [
      tx.pure.bool(p.freezeRequiresUnpaused),
      tx.pure.bool(p.lockCommissionOnFreeze),
      tx.pure.bool(p.pauseBlocksDecryption),
      tx.pure.bool(p.pauseBlocksAccess),
    ],
  }))
  const tail = [
    tx.pure.address(toAddress(opts.paymentRecipient)),
    tx.pure.u64(toU64(opts.defaultUses)),
    tx.pure.bool(opts.soulbound),
    tx.pure.bool(opts.autoBurnAtZero),
    tx.pure.string(opts.nftName),
    tx.pure.string(opts.nftImageUrl),
    tx.pure.string(opts.nftDescription),
    policy,
  ]
  if (BigInt(opts.priceMist) === 0n) {
    if (opts.freeGateFeeMist === undefined) throw new Error('freeGateFeeMist is required for a free gate')
    const fee = splitFromGas(tx, opts.freeGateFeeMist)
    tx.moveCall({
      target: `${packageId}::access_gate::create_free_gate`,
      arguments: [tx.object(platformConfigId), fee, ...tail],
    })
  } else {
    tx.moveCall({
      target: `${packageId}::access_gate::create_gate`,
      arguments: [tx.object(platformConfigId), tx.pure.u64(toU64(opts.priceMist)), ...tail],
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
    // Every gate setter reads the shared PlatformConfig after the gate (version gate).
    arguments: [tx.object(ctx.adminCapId), tx.object(ctx.gateId), tx.object(ctx.platformConfigId), ...extraArgs(tx)],
  })
  return tx
}

/**
 * Set the gate price (in MIST) for future purchases. A paid price must be at least the platform's
 * minimum (`E_PRICE_TOO_LOW`, 11); 0 only once the free-gate fee is paid (`E_FREE_FEE_UNPAID`, 12 —
 * use `buildMakeGateFreeTx`).
 */
export function buildSetPriceTx(ctx: GateAdminContext, priceMist: bigint | number): Transaction {
  return buildGateAdminCall(ctx, 'set_price', (tx) => [tx.pure.u64(toU64(priceMist))])
}

/**
 * Make the gate free (price 0), paying `feeMist` from gas — the platform's `free_gate_fee_mist`, or
 * 0 if this gate already paid it (`OwnedGate.freeFeePaid`). Any excess is refunded on-chain.
 */
export function buildMakeGateFreeTx(ctx: GateAdminContext, feeMist: bigint | number): Transaction {
  const tx = new Transaction()
  const fee = splitFromGas(tx, feeMist)
  tx.moveCall({
    target: `${ctx.packageId}::access_gate::make_gate_free`,
    arguments: [tx.object(ctx.adminCapId), tx.object(ctx.gateId), tx.object(ctx.platformConfigId), fee],
  })
  return tx
}

/** Redirect future purchase payments to a new recipient address. */
export function buildSetPaymentRecipientTx(ctx: GateAdminContext, recipient: string): Transaction {
  return buildGateAdminCall(ctx, 'set_payment_recipient', (tx) => [tx.pure.address(toAddress(recipient))])
}

/** Pause or unpause `purchase` (paused ⇒ `purchase` aborts with `E_PAUSED`). */
export function buildSetPausedTx(ctx: GateAdminContext, paused: boolean): Transaction {
  return buildGateAdminCall(ctx, 'set_paused', (tx) => [tx.pure.bool(paused)])
}

/** Change the default uses for future mints (0 ⇒ unlimited pass; N ⇒ single-use with N). */
export function buildSetDefaultUsesTx(ctx: GateAdminContext, defaultUses: bigint | number): Transaction {
  return buildGateAdminCall(ctx, 'set_default_uses', (tx) => [tx.pure.u64(toU64(defaultUses))])
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
  const payment = splitFromGas(tx, commissionMist)
  tx.moveCall({
    target: `${ctx.packageId}::access_gate::airdrop`,
    arguments: [
      tx.object(ctx.adminCapId),
      tx.object(ctx.gateId),
      tx.object(ctx.platformConfigId),
      payment,
      tx.pure.address(toAddress(recipient)),
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
  const price = toU64(priceMist)
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
  const min = (toU64(minCommissionMist) * BPS_DENOMINATOR + MAX_COMMISSION_BPS - 1n) / MAX_COMMISSION_BPS
  // Saturates at u64::MAX like the contract's `min_paid_price_mist`.
  if (min > MAX_U64) return MAX_U64
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
