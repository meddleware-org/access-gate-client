/**
 * Types for the access-gate client. They mirror the on-chain `access_gate` Move package; keep the
 * two in sync.
 */

/** Identifies a deployed gate and the NFT type that satisfies it. */
export interface AccessGateConfig {
  /** Call target: the package's latest **published-at** ID. */
  packageId: string
  /** The shared `Gate` object ID. */
  gateId: string
  /** The shared `PlatformConfig` object ID. Required for `buildPurchaseTx`. */
  platformConfigId: string
  /**
   * Fully-qualified NFT type to filter ownership by, under the package's **original id**:
   * `<originalId>::access_gate::AccessNFT` or `…::SoulboundAccessNFT` (see `accessNftType`).
   * Choose the variant matching the gate's `soulbound` flag.
   */
  nftType: string
  /** Whether this gate mints soulbound NFTs (selects `consume` vs `consume_soulbound`). */
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
  bps: bigint
  minMist: bigint
}

/** An `access_gate` package's shared `PlatformConfig`. */
export interface PlatformConfigInfo {
  /**
   * The only package version allowed to act on this config and its gates (`migrate` moves it
   * forward). `null` for packages published before version gating.
   */
  version: bigint | null
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
  /** Immutable restrictions (all `false` for gates of package versions that predate policies). */
  policy: GatePolicy
  /** Commission terms snapshotted at freeze (when `policy.lockCommissionOnFreeze`), else `null`. */
  lockedCommission: CommissionTerms | null
  /** True once the free-gate fee has been paid (the price may then be 0). */
  freeFeePaid: boolean
}

/** A parsed owned access NFT. */
export interface OwnedAccessNft {
  objectId: string
  gateId: string
  /** `null` for an unlimited pass; otherwise remaining single-use count. */
  usesRemaining: number | null
}

/**
 * A single owned/read object as returned by the unified core API (`SuiGrpcClient`): the id and
 * Move struct type are top-level; the struct fields come back under `json` (opt-in). Kept as a
 * structural subset so any client exposing the core API satisfies it without importing the SDK.
 */
export interface CoreObject {
  objectId: string
  type?: string
  json?: Record<string, unknown> | null
}

/** Minimal structural subset of a core Sui client used for owned-object listing (`SuiGrpcClient`). */
export interface OwnedObjectsClient {
  core: {
    listOwnedObjects(options: {
      owner: string
      type?: string
      cursor?: string | null
      limit?: number
      include?: { json?: boolean }
    }): Promise<{ objects: CoreObject[]; hasNextPage: boolean; cursor: string | null }>
  }
}

/** Minimal structural subset of a core Sui client used for a typed single-object read. */
export interface SuiObjectClient {
  core: {
    getObject(options: { objectId: string; include?: { json?: boolean } }): Promise<{ object: CoreObject }>
  }
}

/** An event as returned by the core API's `listEvents` (`SuiGrpcClient`), or served by an indexer. */
export interface CoreEventEntry {
  eventType: string
  sender: string
  /** BCS bytes of the event struct (base64 when served by an indexer). */
  bcs: Uint8Array | string
  /** Checkpoint sequence number; `null` where the transport does not report it. */
  checkpoint: string | null
  transactionDigest: string
  eventIndex: number
}

/** Minimal structural subset of a core Sui client used for event queries (`SuiGrpcClient`). */
export interface EventsClient {
  core: {
    listEvents(options: {
      filter?: { eventType: string }
      limit?: number
      before?: string | null
      order?: 'ascending' | 'descending'
    }): Promise<{ events: CoreEventEntry[]; hasNextPage: boolean; endCursor: string | null }>
  }
}

/** Where an event came from, so it can be checked against a full node. */
interface EventOrigin {
  txDigest: string
  eventIndex: number
  /** `null` where the transport does not report it. */
  checkpoint: string | null
  /** Sender of the emitting transaction. */
  sender: string
}

/** `GateCreatedEvent` */
export interface GateCreated extends EventOrigin {
  kind: 'GateCreated'
  gateId: string
  adminCapId: string
  priceMist: bigint
  defaultUses: bigint
  soulbound: boolean
  autoBurnAtZero: boolean
  nftName: string
  policy: GatePolicy
  /** Free-gate fee paid at creation (0 for a paid gate). */
  freeGateFeePaidMist: bigint
  creator: string
  timestampMs: bigint
}

/** `AccessMintedEvent` — a purchase or an airdrop. */
export interface AccessMinted extends EventOrigin {
  kind: 'AccessMinted'
  nftId: string
  gateId: string
  soulbound: boolean
  /** 0 for an unlimited pass; otherwise the single-use starting count. */
  initialUses: bigint
  recipient: string
  commissionMist: bigint
  timestampMs: bigint
}

/** `AccessConsumedEvent` — one use spent. */
export interface AccessConsumed extends EventOrigin {
  kind: 'AccessConsumed'
  nftId: string
  gateId: string
  /** The challenge nonce the consumption is bound to. */
  nonce: Uint8Array
  /** The NFT owner who called `consume`. */
  consumer: string
  usesAfter: bigint
  timestampMs: bigint
}

/** `AccessBurnedEvent` — auto-burn at zero or a voluntary burn. */
export interface AccessBurned extends EventOrigin {
  kind: 'AccessBurned'
  nftId: string
  gateId: string
  timestampMs: bigint
}

/** `GateFrozenEvent` — the gate was made immutable. */
export interface GateFrozen extends EventOrigin {
  kind: 'GateFrozen'
  gateId: string
  /** The commission terms applied from now on, or `null` if the gate follows the live terms. */
  lockedCommission: CommissionTerms | null
  timestampMs: bigint
}

/** `GateMadeFreeEvent` — the price was set to 0. */
export interface GateMadeFree extends EventOrigin {
  kind: 'GateMadeFree'
  gateId: string
  /** Free-gate fee paid now (0 if it had already been paid). */
  feePaidMist: bigint
  timestampMs: bigint
}

/** `PlatformConfigUpdatedEvent` — the resulting platform configuration. */
export interface PlatformConfigUpdated extends EventOrigin {
  kind: 'PlatformConfigUpdated'
  treasury: string
  commissionBps: bigint
  minCommissionMist: bigint
  freeGateFeeMist: bigint
}

/** `PlatformMigratedEvent` — `migrate` retired every package version before `toVersion`. */
export interface PlatformMigrated extends EventOrigin {
  kind: 'PlatformMigrated'
  fromVersion: bigint
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

export type AccessGateEventKind = AccessGateEvent['kind']
