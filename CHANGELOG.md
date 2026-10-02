# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.3] - 2026-10-02

### Changed

- **Parsers fail closed.** `parseGate`, `parsePlatformConfig`, `parseAdminCap` and
  `parseOwnedAccessNft` return `null` when a field is missing or mistyped instead of substituting a
  default (a missing price no longer reads as a free gate; a `"false"` string is not `true`). Every
  `Gate` field, its `policy` and `free_fee_paid` are required; `PlatformConfigInfo.version` is a
  `bigint` (every deployment is version-gated).
- IDs and addresses read from objects are normalised (`0x` + 64 hex), and `fetchAccessNfts` /
  `ownsAccessNft` compare the `gateId` filter normalised, so a short or upper-case id matches.
- Amounts go through the new **`toU64`**: a `number` that is not a safe integer throws instead of
  being encoded as a different amount.
- **`readIndexerEvents`** (new export) is the shared indexer reader: https only (loopback http
  allowed), the timeout, a 1 MiB body cap before parsing and a checked page shape. `IndexerEventsPage`
  is exported with it.
- An event type named after an `Object` prototype key is no longer looked up as a layout.
- `"sideEffects": false`; `noUncheckedIndexedAccess` is on.

## [0.0.2] - 2026-10-02

Follows the version-gated `access_gate` republish (testnet `0xa55789…`, `@meddleware/access-gate-sui`
0.0.5). Breaking for callers of the old package: its PTB shapes no longer match.

### Changed

- **`buildConsumeTx`** passes the shared `PlatformConfig` (`cfg.platformConfigId`) after the gate.
- **Every gate setter** (`buildSet*Tx`) passes `PlatformConfig` after the gate, matching the new
  `(cap, gate, platform, value)` signatures.
- **`./deployments`** regenerated from `@meddleware/access-gate-sui` 0.0.5.

### Added

- **`PlatformConfigInfo.version`** — the package version the config admits (`null` before gating).
- **`PlatformMigrated` event** (`fromVersion`, `toVersion`).
- **Abort codes 13 (`E_WRONG_VERSION`) and 14 (`E_NOT_UPGRADE`)** in `ACCESS_GATE_ABORTS`.

## [0.0.1] - 2026-09-30

First release. The `access_gate` reads and builders move here from `@meddleware/nft-gate-client`
0.0.12, which keeps only the gateway wire protocol.

### Added

- **`./deployments`** — `accessGateDeployment(network)` returns `{ originalId, publishedAt,
  platformConfigId }`.
  - Generated from `@meddleware/access-gate-sui` 0.0.3.
  - CI checks for drift.
- **Events.** `listAccessGateEvents` returns every `access_gate` event, typed per kind and decoded
  from BCS.
  - `AccessConsumed` carries `consumer` and `nonce`.
  - Cursor paging, newest first.
  - Optional read-indexer source with a 3 s fallback to the full node.
  - Also exported: `parseAccessGateEvent`, `accessGateEventType`, `ACCESS_GATE_EVENT_KINDS`.
- **Reads.**
  - `ownsPlatformAdminCap`.
  - `listAllOwnedObjects` (paged, bounded by `MAX_OWNED_PAGES`).
  - `fetchPlatformConfig` returns every field and throws for a wrong object.
- **Errors.** `ACCESS_GATE_ABORTS` (codes 1–12) and `abortMessage(error, originalId?)`.
- **Type strings.** `accessGateType`, `accessNftType`, `isAccessGateType`, `normalizeAccessNftType`.

### Changed (from nft-gate-client 0.0.12)

- **Exact type matching.**
  - Parsers compare the normalised full type; suffix matching is gone.
  - They take the type they expect: `parseOwnedAccessNft(entry, nftType)`,
    `parseAdminCap(entry, originalId)`, `parseGate(entry, originalId)`,
    `parsePlatformConfig(entry, originalId)`.
  - `fetchGate`, `fetchPlatformConfig` and `fetchAccessNftById` take the same extra argument.
- **Paging.** Owned-object reads follow every page. Before, only the first page was read.
  `ownsAccessNft` stops at the first match.
- `fetchAdminCaps` / `fetchOwnedGates` take the package's **original id** (they used to take
  `packageId`).
