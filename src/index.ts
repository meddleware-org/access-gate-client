/**
 * `@meddleware/access-gate-client` — the client for the `access_gate` Move package: typed reads
 * of gates, NFTs and the platform config; typed events; transaction builders; abort messages.
 * Deployment ids are in the `@meddleware/access-gate-client/deployments` subpath.
 *
 * ID rule: transactions call the latest **published-at** id (`packageId`); types and events are
 * matched at the **original id** (`originalId`, `nftType`).
 */

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

export {
  ACCESS_GATE_MODULE,
  accessGateType,
  accessNftType,
  isAccessGateType,
  normalizeAccessNftType,
} from './typeNames.js'
export type { AccessGateStruct, AccessGateEventStruct } from './typeNames.js'

export {
  MAX_OWNED_PAGES,
  listAllOwnedObjects,
  fetchAccessNfts,
  ownsAccessNft,
  parseOwnedAccessNft,
  fetchAccessNftById,
} from './ownership.js'
export {
  parseAdminCap,
  parseGate,
  parsePlatformConfig,
  fetchAdminCaps,
  fetchGate,
  fetchOwnedGates,
  fetchPlatformConfig,
  ownsPlatformAdminCap,
} from './gates.js'
export type { GateState } from './gates.js'

export {
  ACCESS_GATE_EVENT_KINDS,
  accessGateEventType,
  parseAccessGateEvent,
  eventGateId,
  listAccessGateEvents,
  readIndexerEvents,
} from './events.js'
export type {
  EventCursor,
  IndexerSource,
  IndexerEventsPage,
  ListAccessGateEventsOptions,
  AccessGateEventPage,
} from './events.js'

export { ACCESS_GATE_ABORTS, abortMessage } from './aborts.js'
export type { AccessGateAbort } from './aborts.js'

export {
  DEFAULT_GATE_POLICY,
  isRestrictivePolicy,
  BPS_DENOMINATOR,
  MAX_COMMISSION_BPS,
  platformCommissionTerms,
  commissionForPrice,
  minimumPaidPriceMist,
  gateCommissionMist,
  toU64,
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
  buildMakeGateFreeTx,
  buildMakeGateImmutableTx,
} from './ptb.js'
