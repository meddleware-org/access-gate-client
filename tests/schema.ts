// The on-chain shape of every access_gate struct this package decodes or reads, as of the recorded
// deployment: field names, order and Move types (`$PKG` = the package's own id). Two checks use it:
// the offline schema test encodes values from it and requires the parsers to read them back, and the
// testnet drift check requires the live package to still match it field for field.
export const STRUCT_SCHEMAS: Record<string, [name: string, type: string][]> = {
  GateCreatedEvent: [
    ['gate_id', '0x2::object::ID'],
    ['admin_cap_id', '0x2::object::ID'],
    ['price_mist', 'u64'],
    ['default_uses', 'u64'],
    ['soulbound', 'bool'],
    ['auto_burn_at_zero', 'bool'],
    ['nft_name', '0x1::string::String'],
    ['policy', '$PKG::access_gate::GatePolicy'],
    ['free_gate_fee_paid_mist', 'u64'],
    ['creator', 'address'],
    ['timestamp_ms', 'u64'],
  ],
  AccessMintedEvent: [
    ['nft_id', '0x2::object::ID'],
    ['gate_id', '0x2::object::ID'],
    ['soulbound', 'bool'],
    ['initial_uses', 'u64'],
    ['recipient', 'address'],
    ['commission_mist', 'u64'],
    ['timestamp_ms', 'u64'],
  ],
  AccessConsumedEvent: [
    ['nft_id', '0x2::object::ID'],
    ['gate_id', '0x2::object::ID'],
    ['nonce', 'vector<u8>'],
    ['consumer', 'address'],
    ['uses_after', 'u64'],
    ['timestamp_ms', 'u64'],
  ],
  AccessBurnedEvent: [
    ['nft_id', '0x2::object::ID'],
    ['gate_id', '0x2::object::ID'],
    ['timestamp_ms', 'u64'],
  ],
  GateFrozenEvent: [
    ['gate_id', '0x2::object::ID'],
    ['locked_commission', '0x1::option::Option<$PKG::access_gate::CommissionTerms>'],
    ['timestamp_ms', 'u64'],
  ],
  GateMadeFreeEvent: [
    ['gate_id', '0x2::object::ID'],
    ['fee_paid_mist', 'u64'],
    ['timestamp_ms', 'u64'],
  ],
  PlatformConfigUpdatedEvent: [
    ['treasury', 'address'],
    ['commission_bps', 'u64'],
    ['min_commission_mist', 'u64'],
    ['free_gate_fee_mist', 'u64'],
  ],
  PlatformMigratedEvent: [
    ['from_version', 'u64'],
    ['to_version', 'u64'],
  ],
  Gate: [
    ['id', '0x2::object::UID'],
    ['admin_cap_id', '0x2::object::ID'],
    ['price_mist', 'u64'],
    ['payment_recipient', 'address'],
    ['default_uses', 'u64'],
    ['soulbound', 'bool'],
    ['auto_burn_at_zero', 'bool'],
    ['paused', 'bool'],
    ['frozen', 'bool'],
    ['nft_name', '0x1::string::String'],
    ['nft_image_url', '0x1::string::String'],
    ['nft_description', '0x1::string::String'],
    ['policy', '$PKG::access_gate::GatePolicy'],
    ['locked_commission', '0x1::option::Option<$PKG::access_gate::CommissionTerms>'],
    ['free_fee_paid', 'bool'],
  ],
  PlatformConfig: [
    ['id', '0x2::object::UID'],
    ['version', 'u64'],
    ['treasury', 'address'],
    ['commission_bps', 'u64'],
    ['min_commission_mist', 'u64'],
    ['free_gate_fee_mist', 'u64'],
  ],
  AdminCap: [
    ['id', '0x2::object::UID'],
    ['gate_id', '0x2::object::ID'],
  ],
  AccessData: [
    ['gate_id', '0x2::object::ID'],
    ['variant', '$PKG::access_gate::AccessVariant'],
    ['minted_epoch', 'u64'],
  ],
  CommissionTerms: [
    ['bps', 'u64'],
    ['min_mist', 'u64'],
  ],
  GatePolicy: [
    ['freeze_requires_unpaused', 'bool'],
    ['lock_commission_on_freeze', 'bool'],
    ['pause_blocks_decryption', 'bool'],
    ['pause_blocks_access', 'bool'],
  ],
  AccessNFT: [
    ['id', '0x2::object::UID'],
    ['data', '$PKG::access_gate::AccessData'],
    ['name', '0x1::string::String'],
    ['image_url', '0x1::string::String'],
    ['description', '0x1::string::String'],
  ],
  SoulboundAccessNFT: [
    ['id', '0x2::object::UID'],
    ['data', '$PKG::access_gate::AccessData'],
    ['name', '0x1::string::String'],
    ['image_url', '0x1::string::String'],
    ['description', '0x1::string::String'],
  ],
}

/** The access_gate event structs, in kind order. */
export const EVENT_STRUCTS = Object.keys(STRUCT_SCHEMAS).filter((n) => n.endsWith('Event'))
