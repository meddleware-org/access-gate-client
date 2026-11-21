/**
 * @file Types for the access-gate client. They mirror the on-chain `access_gate` Move package; keep the two in sync.
 *
 * Role: the shapes every other module in the package produces or accepts: the configuration a caller passes to a builder, the parsed objects and events,
 * and the structural subsets of a Sui client (`OwnedObjectsClient`, `SuiObjectClient`, `EventsClient`) that let any client exposing the core API be used
 * without importing the SDK here. Types only: this file has no runtime code.
 *
 * Money is `bigint` everywhere (MIST, basis points, counts are u64 on chain); ids are normalised `0x` + 64-digit strings (see `json.ts`).
 */

/** Identifies a deployed gate and the NFT type that satisfies it. */
export interface AccessGateConfig {
  /** Call target: the package's latest **published-at** ID. */
  packageId: string
  /** The shared `Gate` object ID. */
  gateId: string
  /** The shared `PlatformConfig` object ID (the version gate): read by purchase and consume. */
  platformConfigId: string
  /**
   * Fully-qualified NFT type to filter ownership by, under the package's **original id**:
   * `<originalId>::access_gate::AccessNFT` or `…::SoulboundAccessNFT` (see `accessNftType`).
   * Choose the variant matching the gate's `soulbound` flag.
   */
  nftType: string
  /**
   * Optional cross-check: whether this gate mints soulbound NFTs. `consume` vs `consume_soulbound` is
   * derived from `nftType`; if this is set and disagrees, `buildConsumeTx` throws.
   */
  soulbound?: boolean
}

/**
 * Identifies a gate an operator administers, for the AdminCap-gated management PTB builders
 * (setters, airdrop, freeze). The three ids together authorise a call: `adminCapId` must be the
 * `AdminCap` whose `gate_id` matches `gateId`.
 */
export interface GateAdminContext {
  /** Call target: the package's latest **published-at** ID. */
  packageId: string
  /** The shared `Gate` object ID being administered. */
  gateId: string
  /** The `AdminCap` object ID authorised over `gateId` (held by the operator). */
  adminCapId: string
  /** The package's shared `PlatformConfig` (read by set-price, airdrop, make-free and freeze). */
  platformConfigId: string
}

/**
 * Operator-selectable restrictions stored immutably on a gate at creation (`GatePolicy` on-chain).
 * Every flag is `false` by default (the unrestricted behaviour). A tool's operator chooses which to
 * apply to the gates it creates; buyers can read them from the gate.
 */
export interface GatePolicy {
  /** `make_gate_immutable` aborts while the gate is paused (no permanently unsellable frozen gates). */
  freezeRequiresUnpaused: boolean
  /** Freezing snapshots the platform commission; frozen purchases use the snapshot. */
  lockCommissionOnFreeze: boolean
  /** Dependent decryption policies (Seal `nft_gate`) deny access while the gate is paused. */
  pauseBlocksDecryption: boolean
  /** While paused, `consume` aborts and access gateways deny holders. */
  pauseBlocksAccess: boolean
}

/** A commission rule: `max(price × bps / 10000, minMist)`, capped at 10% of the price. */
export interface CommissionTerms {
  /** The percentage of the price, in basis points (1 bp = 0.01%; at most 1000 = 10%). */
  bps: bigint
  /** The floor, in MIST, so a small price still pays a meaningful commission. */
  minMist: bigint
}

/** An `access_gate` package's shared `PlatformConfig`. */
export interface PlatformConfigInfo {
  /**
   * The only package version allowed to act on this config and its gates (`migrate` moves it
   * forward).
   */
  version: bigint
  /** Receives commissions and fees. */
  treasury: string
  /** Commission in basis points (≤ 1000). */
  commissionBps: bigint
  /** Floor on a paid mint's commission (MIST). */
  minCommissionMist: bigint
  /** One-off fee (MIST) to make a gate free. */
  freeGateFeeMist: bigint
}

/** A gate an operator administers, parsed from its on-chain `Gate` object + owning `AdminCap`. */
export interface OwnedGate {
  /** The shared `Gate` object ID. */
  gateId: string
  /** The `AdminCap` object ID that authorises administering this gate. */
  adminCapId: string
  /** Price in MIST charged by `purchase` (0 = free). */
  priceMist: bigint
  /** Address that receives the operator share of each paid `purchase`. */
  paymentRecipient: string
  /** 0 ⇒ unlimited passes; N ⇒ single-use NFTs with N uses. */
  defaultUses: bigint
  /** Whether newly-minted NFTs are soulbound. */
  soulbound: boolean
  /** Whether a single-use NFT is deleted (vs. kept as a receipt) at zero uses. */
  autoBurnAtZero: boolean
  /** Whether `purchase` is currently disabled. */
  paused: boolean
  /** Whether the gate has been made immutable (all admin/airdrop permanently disabled). */
  frozen: boolean
  /** Default NFT display name minted into future NFTs. */
  nftName: string
  /** Default NFT image URL minted into future NFTs. */
  nftImageUrl: string
  /** Default NFT description minted into future NFTs. */
  nftDescription: string
  /** Immutable restrictions, fixed at creation. */
  policy: GatePolicy
  /** Commission terms snapshotted at freeze (when `policy.lockCommissionOnFreeze`), else `null`. */
  lockedCommission: CommissionTerms | null
  /** True once the free-gate fee has been paid (the price may then be 0). */
  freeFeePaid: boolean
}

/**
 * What a pass allows, as the chain's `AccessVariant` enum: an unlimited pass, or a single-use pass
 * with a remaining count (a u64, so a `bigint`). Never inferred from a missing field.
 */
export type PassVariant = { kind: 'unlimited' } | { kind: 'singleUse'; remaining: bigint }

/** A parsed owned access NFT. */
export interface OwnedAccessNft {
  /** The NFT's object id. */
  objectId: string
  /** The gate this NFT grants access to. */
  gateId: string
  /** Unlimited, or single-use with a count left. */
  variant: PassVariant
}

/**
 * A single owned/read object as returned by the unified core API (`SuiGrpcClient`): the id and
 * Move struct type are top-level; the struct fields come back under `json` (opt-in). Kept as a
 * structural subset so any client exposing the core API satisfies it without importing the SDK.
 */
export interface CoreObject {
  /** The object's id. */
  objectId: string
  /** The Move struct type, e.g. `0x…::access_gate::AccessNFT`. */
  type?: string
  /** The struct's fields, present only when the call asked for `include: { json: true }`. */
  json?: Record<string, unknown> | null
}

/** Minimal structural subset of a core Sui client used for owned-object listing (`SuiGrpcClient`). */
export interface OwnedObjectsClient {
  /** The SDK's unified core API. */
  core: {
    /** One page of the objects an address owns, optionally only of one type, with their fields when `include.json` is set. */
    listOwnedObjects(options: {
      /** The owner's address. */
      owner: string
      /** Only objects of this Move type. */
      type?: string
      /** Where the previous page ended (`null` or absent for the first page). */
      cursor?: string | null
      /** The page size. */
      limit?: number
      /** Ask for the object's fields as JSON. */
      include?: { json?: boolean }
    }): Promise<{ objects: CoreObject[]; hasNextPage: boolean; cursor: string | null }>
  }
}

/** Minimal structural subset of a core Sui client used for a typed single-object read. */
export interface SuiObjectClient {
  /** The SDK's unified core API. */
  core: {
    /** One object by id, with its fields when `include.json` is set; rejects when it does not exist. */
    getObject(options: { objectId: string; include?: { json?: boolean } }): Promise<{ object: CoreObject }>
  }
}

/** An event as returned by the core API's `listEvents` (`SuiGrpcClient`), or served by an indexer. */
export interface CoreEventEntry {
  /** The event's Move type. */
  eventType: string
  /** The address that sent the emitting transaction. */
  sender: string
  /** BCS bytes of the event struct (base64 when served by an indexer). */
  bcs: Uint8Array | string
  /** Checkpoint sequence number; `null` where the transport does not report it. */
  checkpoint: string | null
  /** The emitting transaction's digest. */
  transactionDigest: string
  /** The event's position within that transaction. */
  eventIndex: number
}

/** Minimal structural subset of a core Sui client used for event queries (`SuiGrpcClient`). */
export interface EventsClient {
  /** The SDK's unified core API. */
  core: {
    /** One page of events, newest first by default, optionally only of one Move type. */
    listEvents(options: {
      /** Only events of this type. */
      filter?: { eventType: string }
      /** The page size. */
      limit?: number
      /** Where the previous page ended. */
      before?: string | null
      /** The order to read in. */
      order?: 'ascending' | 'descending'
    }): Promise<{ events: CoreEventEntry[]; hasNextPage: boolean; endCursor: string | null }>
  }
}

/** Where an event came from, so it can be checked against a full node. */
interface EventOrigin {
  /** The emitting transaction's digest. */
  txDigest: string
  /** The event's position within that transaction. */
  eventIndex: number
  /** `null` where the transport does not report it. */
  checkpoint: string | null
  /** Sender of the emitting transaction. */
  sender: string
}

/** `GateCreatedEvent` */
export interface GateCreated extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'GateCreated'
  /** The new gate. */
  gateId: string
  /** The admin capability created with it. */
  adminCapId: string
  /** The price in MIST (0 = free). */
  priceMist: bigint
  /** 0 for an unlimited pass, else the starting uses of each NFT. */
  defaultUses: bigint
  /** Whether the NFTs are soulbound. */
  soulbound: boolean
  /** Whether a single-use NFT is deleted at zero uses. */
  autoBurnAtZero: boolean
  /** The default NFT display name. */
  nftName: string
  /** The immutable restrictions chosen at creation. */
  policy: GatePolicy
  /** Free-gate fee paid at creation (0 for a paid gate). */
  freeGateFeePaidMist: bigint
  /** The address that created the gate. */
  creator: string
  /** The chain's clock when it was created (milliseconds since the Unix epoch). */
  timestampMs: bigint
}

/** `AccessMintedEvent` — a purchase or an airdrop. */
export interface AccessMinted extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'AccessMinted'
  /** The minted NFT. */
  nftId: string
  /** The gate it grants access to. */
  gateId: string
  /** Whether the NFT is soulbound. */
  soulbound: boolean
  /** 0 for an unlimited pass; otherwise the single-use starting count. */
  initialUses: bigint
  /** Who received the NFT. */
  recipient: string
  /** The commission paid to the platform (MIST). */
  commissionMist: bigint
  /** The chain's clock at the mint (ms since the Unix epoch). */
  timestampMs: bigint
}

/** `AccessConsumedEvent` — one use spent. */
export interface AccessConsumed extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'AccessConsumed'
  /** The NFT a use was spent from. */
  nftId: string
  /** The gate it belongs to. */
  gateId: string
  /** The challenge nonce the consumption is bound to. */
  nonce: Uint8Array
  /** The NFT owner who called `consume`. */
  consumer: string
  /** Uses left after this one. */
  usesAfter: bigint
  /** The chain's clock at the consume (ms since the Unix epoch). */
  timestampMs: bigint
}

/** `AccessBurnedEvent` — auto-burn at zero or a voluntary burn. */
export interface AccessBurned extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'AccessBurned'
  /** The burned NFT. */
  nftId: string
  /** The gate it belonged to. */
  gateId: string
  /** The chain's clock at the burn (ms since the Unix epoch). */
  timestampMs: bigint
}

/** `GateFrozenEvent` — the gate was made immutable. */
export interface GateFrozen extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'GateFrozen'
  /** The gate that was frozen. */
  gateId: string
  /** The commission terms applied from now on, or `null` if the gate follows the live terms. */
  lockedCommission: CommissionTerms | null
  /** The chain's clock at the freeze (ms since the Unix epoch). */
  timestampMs: bigint
}

/** `GateMadeFreeEvent` — the price was set to 0. */
export interface GateMadeFree extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'GateMadeFree'
  /** The gate whose price became 0. */
  gateId: string
  /** Free-gate fee paid now (0 if it had already been paid). */
  feePaidMist: bigint
  /** The chain's clock at the change (ms since the Unix epoch). */
  timestampMs: bigint
}

/** `PlatformConfigUpdatedEvent` — the resulting platform configuration. */
export interface PlatformConfigUpdated extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'PlatformConfigUpdated'
  /** The treasury address now in force. */
  treasury: string
  /** The commission, in basis points, now in force. */
  commissionBps: bigint
  /** The minimum commission (MIST) now in force. */
  minCommissionMist: bigint
  /** The one-off fee (MIST) to make a gate free, now in force. */
  freeGateFeeMist: bigint
}

/** `PlatformMigratedEvent` — `migrate` retired every package version before `toVersion`. */
export interface PlatformMigrated extends EventOrigin {
  /** The discriminant of `AccessGateEvent`. */
  kind: 'PlatformMigrated'
  /** The version before the migration. */
  fromVersion: bigint
  /** The version after it; every package version below it is retired. */
  toVersion: bigint
}

/** Any `access_gate` event, discriminated by `kind`. */
export type AccessGateEvent =
  | GateCreated
  | AccessMinted
  | AccessConsumed
  | AccessBurned
  | GateFrozen
  | GateMadeFree
  | PlatformConfigUpdated
  | PlatformMigrated

/** The names of the event kinds: the `kind` of each member of `AccessGateEvent`. */
export type AccessGateEventKind = AccessGateEvent['kind']
