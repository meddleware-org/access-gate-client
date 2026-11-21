// Every transaction builder, called with placeholder ids, and the Move calls it produces. Shared by
// the offline completeness test and the testnet ABI-drift check (tests/integration/abi-drift).
import type { Transaction } from '@mysten/sui/transactions'
import * as client from '../src/index.js'

/** A placeholder package id: any 32-byte value, since nothing here reads a chain. */
export const PKG = '0x' + 'a1'.repeat(32)
/** A distinct placeholder object id per number, so a test can tell which argument went where. */
const id = (n: number) => '0x' + n.toString(16).padStart(64, '0')
// The configuration of a purchasable gate (unsoulbound `AccessNFT`).
const cfg = { packageId: PKG, gateId: id(1), platformConfigId: id(2), nftType: `${PKG}::access_gate::AccessNFT` }
// The administrator's context: the same gate and config, plus a cap.
const ctx = { packageId: PKG, gateId: id(1), adminCapId: id(3), platformConfigId: id(2) }
// The options of a paid, single-use, soulbound gate with the default (unrestricted) policy.
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
  buildConsumeTx: () => [client.buildConsumeTx(cfg, id(5), 'nonce-123'), client.buildConsumeTx({ ...cfg, nftType: `${PKG}::access_gate::SoulboundAccessNFT` }, id(5), 'nonce-123')],
  buildCreateGateTx: () => [client.buildCreateGateTx(PKG, id(2), gate), client.buildCreateGateTx(PKG, id(2), { ...gate, priceMist: 0n, freeGateFeeMist: 1n })],
  buildSetPriceTx: () => [client.buildSetPriceTx(ctx, 1n)],
  buildMakeGateFreeTx: () => [client.buildMakeGateFreeTx(ctx, 1n)],
  buildSetPaymentRecipientTx: () => [client.buildSetPaymentRecipientTx(ctx, id(4))],
  buildSetPausedTx: () => [client.buildSetPausedTx(ctx, true)],
  buildSetDefaultUsesTx: () => [client.buildSetDefaultUsesTx(ctx, 1n)],
  buildSetAutoBurnAtZeroTx: () => [client.buildSetAutoBurnAtZeroTx(ctx, true)],
  buildSetNftNameTx: () => [client.buildSetNftNameTx(ctx, 'n')],
  buildSetNftImageUrlTx: () => [client.buildSetNftImageUrlTx(ctx, 'https://x/y.png')],
  buildSetNftDescriptionTx: () => [client.buildSetNftDescriptionTx(ctx, 'd')],
  buildAirdropTx: () => [client.buildAirdropTx(ctx, id(4), 1n)],
  buildMakeGateImmutableTx: () => [client.buildMakeGateImmutableTx(ctx)],
}

/** One Move call in a transaction, reduced to what the ABI check compares. */
export interface MoveCallShape {
  /** The package id the call targets. */
  package: string
  /** The module. */
  module: string
  /** The function. */
  function: string
  /** How many type arguments the call carries. */
  typeArguments: number
  /** How many arguments the call carries. */
  arguments: number
}

/** The Move calls in `tx`, as target + arity. */
export function moveCalls(tx: Transaction): MoveCallShape[] {
  // Only `MoveCall` commands matter; a split-coins command is not a call into the package.
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
  // Keyed by target, so a builder that appears in two variants (consume, create) counts once per function.
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

/**
 * The parameter list of every Move function the builders call, as the chain must show it (TxContext, which
 * the runtime injects, is left out): reference kind and type per position. `$PKG` is the package's own id;
 * `Coin<SUI>` and `String` stand for `0x2::coin::Coin<0x2::sui::SUI>` and `0x1::string::String`.
 * The testnet drift check compares each entry with the live package, so a reordered or retyped parameter of
 * the same arity — `&Gate` becoming `&mut Gate`, `u64` becoming `u128` — fails there.
 */
export const EXPECTED_PARAMS: Record<string, string[]> = {
  'access_gate::purchase': ['&Gate', '&PlatformConfig', 'Coin<SUI>'],
  'access_gate::consume': ['AccessNFT', '&Gate', '&PlatformConfig', 'vector<u8>'],
  'access_gate::consume_soulbound': ['SoulboundAccessNFT', '&Gate', '&PlatformConfig', 'vector<u8>'],
  'access_gate::new_gate_policy': ['bool', 'bool', 'bool', 'bool'],
  'access_gate::create_gate': ['&PlatformConfig', 'u64', 'address', 'u64', 'bool', 'bool', 'String', 'String', 'String', 'GatePolicy'],
  'access_gate::create_free_gate': ['&PlatformConfig', 'Coin<SUI>', 'address', 'u64', 'bool', 'bool', 'String', 'String', 'String', 'GatePolicy'],
  'access_gate::set_price': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'u64'],
  'access_gate::make_gate_free': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'Coin<SUI>'],
  'access_gate::set_payment_recipient': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'address'],
  'access_gate::set_paused': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'bool'],
  'access_gate::set_default_uses': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'u64'],
  'access_gate::set_auto_burn_at_zero': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'bool'],
  'access_gate::set_nft_name': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'String'],
  'access_gate::set_nft_image_url': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'String'],
  'access_gate::set_nft_description': ['&AdminCap', '&mut Gate', '&PlatformConfig', 'String'],
  'access_gate::airdrop': ['&AdminCap', '&Gate', '&PlatformConfig', 'Coin<SUI>', 'address'],
  'access_gate::make_gate_immutable': ['AdminCap', '&mut Gate', '&PlatformConfig'],
}

/** The parameter types that are built as pure values (everything else is an object or an earlier result). */
const PURE = /^(u8|u16|u32|u64|u128|u256|bool|address|String|vector<u8>)$/

/** The kind of value each argument of a Move call is built from: a pure input, or an object / earlier result. */
export function argumentKinds(tx: Transaction): { call: string; kinds: ('pure' | 'object')[] }[] {
  const data = tx.getData()
  return data.commands.flatMap((c) => {
    if (c.$kind !== 'MoveCall') return []
    // One kind per argument, in position order.
    const kinds = c.MoveCall.arguments.map((a) => {
      if (a.$kind === 'Input') return data.inputs[a.Input]?.$kind === 'Pure' ? ('pure' as const) : ('object' as const)
      return 'object' as const // a Result / NestedResult / GasCoin produced by an earlier command
    })
    return [{ call: `${c.MoveCall.module}::${c.MoveCall.function}`, kinds }]
  })
}

/** Whether an expected parameter is a pure value (everything else is an object, or an object-valued result). */
export const isPureParam = (expected: string): boolean => PURE.test(expected)
