// Every transaction builder, called with placeholder ids, and the Move calls it produces. Shared by
// the offline completeness test and the testnet ABI-drift check (tests/integration/abi-drift).
import type { Transaction } from '@mysten/sui/transactions'
import * as client from '../src/index.js'

export const PKG = '0x' + 'a1'.repeat(32)
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')
const cfg = { packageId: PKG, gateId: id(1), platformConfigId: id(2), nftType: `${PKG}::access_gate::AccessNFT` }
const ctx = { packageId: PKG, gateId: id(1), adminCapId: id(3), platformConfigId: id(2) }
const gate = {
  priceMist: 10_000_000n,
  paymentRecipient: id(4),
  defaultUses: 1n,
  soulbound: true,
  autoBurnAtZero: false,
  nftName: 'n',
  nftImageUrl: '',
  nftDescription: 'd',
}

/** Builder name → transactions it builds (several when a flag selects a different Move function). */
export const BUILDERS: Record<string, () => Transaction[]> = {
  buildPurchaseTx: () => [client.buildPurchaseTx(cfg, 1n)],
  buildConsumeTx: () => [client.buildConsumeTx(cfg, id(5), 'nonce-123'), client.buildConsumeTx({ ...cfg, soulbound: true }, id(5), 'nonce-123')],
  buildCreateGateTx: () => [client.buildCreateGateTx(PKG, id(2), gate), client.buildCreateGateTx(PKG, id(2), { ...gate, priceMist: 0n, freeGateFeeMist: 1n })],
  buildSetPriceTx: () => [client.buildSetPriceTx(ctx, 1n)],
  buildMakeGateFreeTx: () => [client.buildMakeGateFreeTx(ctx, 1n)],
  buildSetPaymentRecipientTx: () => [client.buildSetPaymentRecipientTx(ctx, id(4))],
  buildSetPausedTx: () => [client.buildSetPausedTx(ctx, true)],
  buildSetDefaultUsesTx: () => [client.buildSetDefaultUsesTx(ctx, 1n)],
  buildSetSoulboundTx: () => [client.buildSetSoulboundTx(ctx, true)],
  buildSetAutoBurnAtZeroTx: () => [client.buildSetAutoBurnAtZeroTx(ctx, true)],
  buildSetNftNameTx: () => [client.buildSetNftNameTx(ctx, 'n')],
  buildSetNftImageUrlTx: () => [client.buildSetNftImageUrlTx(ctx, 'https://x/y.png')],
  buildSetNftDescriptionTx: () => [client.buildSetNftDescriptionTx(ctx, 'd')],
  buildAirdropTx: () => [client.buildAirdropTx(ctx, id(4), 1n)],
  buildMakeGateImmutableTx: () => [client.buildMakeGateImmutableTx(ctx)],
}

export interface MoveCallShape {
  package: string
  module: string
  function: string
  typeArguments: number
  arguments: number
}

/** The Move calls in `tx`, as target + arity. */
export function moveCalls(tx: Transaction): MoveCallShape[] {
  return tx.getData().commands.flatMap((c) =>
    c.$kind === 'MoveCall'
      ? [{
          package: c.MoveCall.package,
          module: c.MoveCall.module,
          function: c.MoveCall.function,
          typeArguments: c.MoveCall.typeArguments.length,
          arguments: c.MoveCall.arguments.length,
        }]
      : [],
  )
}

/** Every distinct Move call the builders make. */
export function allMoveCalls(): MoveCallShape[] {
  const seen = new Map<string, MoveCallShape>()
  for (const build of Object.values(BUILDERS)) {
    for (const tx of build()) {
      for (const call of moveCalls(tx)) seen.set(`${call.package}::${call.module}::${call.function}`, call)
    }
  }
  return [...seen.values()]
}

/** Exported builder names (`build…Tx`). */
export const exportedBuilders = Object.keys(client).filter((k) => /^build\w*Tx$/.test(k)).sort()
