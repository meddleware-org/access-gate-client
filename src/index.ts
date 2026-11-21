/**
 * `@meddleware/access-gate-client` — the client for the `access_gate` Move package: typed reads
 * of gates, NFTs and the platform config; typed events; transaction builders; abort messages.
 * Deployment ids are in the `@meddleware/access-gate-client/deployments` subpath.
 *
 * ID rule: transactions call the latest **published-at** id (`packageId`); types and events are
 * matched at the **original id** (`originalId`, `nftType`).
 *
 * This file is the public surface: it only re-exports (types, then names, ownership, gates, events, aborts, then the transaction builders and the
 * commission arithmetic). Anything not exported here is internal and may change without notice (see `docs/INTEROP.md` and the changelog).
 */

// Types first: they are erased at runtime, so a consumer importing only types pulls in no code.

// Configuration (what a caller passes to a builder), parsed objects, the structural client subsets and the event types, all from `types.ts`.
export type {
  AccessGateConfig,
  CoreObject,
  CoreEventEntry,
  GateAdminContext,
  GatePolicy,
  CommissionTerms,
  PlatformConfigInfo,
  OwnedGate,
  OwnedAccessNft,
  PassVariant,
  OwnedObjectsClient,
  SuiObjectClient,
  EventsClient,
  AccessGateEvent,
  AccessGateEventKind,
  GateCreated,
  AccessMinted,
  AccessConsumed,
  AccessBurned,
  GateFrozen,
  GateMadeFree,
  PlatformConfigUpdated,
  PlatformMigrated,
} from './types.js'

// Names of the Move types and the exact-match checks: a type is built or compared at the original id and never matched by suffix.
export {
  // The module name and the builders of full type strings; `isAccessGateType` and `normalizeAccessNftType` are the exact-match checks.
  ACCESS_GATE_MODULE,
  accessGateType,
  accessNftType,
  isAccessGateType,
  normalizeAccessNftType,
} from './typeNames.js'
// The unions of struct and event-struct names that `accessGateType` accepts.
export type { AccessGateStruct, AccessGateEventStruct } from './typeNames.js'

// Ownership reads: does this address hold a pass? `ownsAccessNft` is the authorisation check; it counts only usable passes unless told otherwise.
export {
  // `MAX_OWNED_PAGES` bounds a listing: more pages than this is an error, never a silently short list.
  MAX_OWNED_PAGES,
  listAllOwnedObjects,
  fetchAccessNfts,
  ownsAccessNft,
  isUsablePass,
  parseOwnedAccessNft,
  fetchAccessNftById,
} from './ownership.js'// Gate and platform reads, for operators: the gates an address administers, one gate, the platform's terms and the cap that governs them.
export {
  // The `parse*` functions are pure (they read a fetched object); the `fetch*` functions make the node calls.
  parseAdminCap,
  parseGate,
  parsePlatformConfig,
  fetchAdminCaps,
  fetchGate,
  fetchOwnedGates,
  fetchPlatformConfig,
  ownsPlatformAdminCap,
} from './gates.js'
// A gate as read from the chain, without its owning cap.
export type { GateState } from './gates.js'

// Events: listing (indexer first, full node as the fallback), decoding one event, and the indexer reader that sealed-storage-client also uses.
export {
  // `STALE_AFTER_MS` and `CLOCK_SKEW_TOLERANCE_MS` are the indexer freshness limits (see the README's Events section).
  ACCESS_GATE_EVENT_KINDS,
  accessGateEventType,
  parseAccessGateEvent,
  eventGateId,
  listAccessGateEvents,
  readIndexerEvents,
  STALE_AFTER_MS,
  CLOCK_SKEW_TOLERANCE_MS,
} from './events.js'
// The option and result types of the event listing.
export type {
  EventCursor,
  IndexerSource,
  IndexerEventsPage,
  ListAccessGateEventsOptions,
  AccessGateEventPage,
} from './events.js'

// Abort messages for a failed transaction.
export { ACCESS_GATE_ABORTS, abortMessage } from './aborts.js'
// The shape of one abort-table entry.
export type { AccessGateAbort } from './aborts.js'
export type { GatePolicyViolation } from './ptb.js'

// Transaction builders, their argument validators and the commission arithmetic (all in `ptb.ts`).
// The policy helpers and the commission numbers come first, then the argument converters, then one builder per contract entry point.
export {
  // Policy helpers and the commission constants first.
  DEFAULT_GATE_POLICY,
  isRestrictivePolicy,
  validateGatePolicy,
  BPS_DENOMINATOR,
  MAX_COMMISSION_BPS,
  platformCommissionTerms,
  commissionForPrice,
  minimumPaidPriceMist,
  gateCommissionMist,
  toAddress,
  toPaymentRecipient,
  toU64,
  buildPurchaseTx,
  buildConsumeTx,
  buildCreateGateTx,
  buildSetPriceTx,
  buildSetPaymentRecipientTx,
  buildSetPausedTx,
  buildSetDefaultUsesTx,
  buildSetAutoBurnAtZeroTx,
  buildSetNftNameTx,
  buildSetNftImageUrlTx,
  buildSetNftDescriptionTx,
  buildAirdropTx,
  buildMakeGateFreeTx,
  buildMakeGateImmutableTx,
} from './ptb.js'
