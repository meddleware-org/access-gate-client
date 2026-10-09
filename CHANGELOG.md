# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.0.8] - 2026-10-09

### Changed

- **Breaking (pre-v0.2):** `buildSetSoulboundTx` is removed (the contract has no `set_soulbound`; the pass kind is fixed at creation). `set_default_uses` cannot cross zero (`E_USES_KIND_IMMUTABLE`). Deployments regenerated for the 2026-10-09 testnet publication (access_gate 0xd7ddaa94…, @meddleware/access-gate-sui 0.0.6)

## [0.0.7] - 2026-10-08

### Fixed

- `buildConsumeTx` refuses a nonce shorter than 8 bytes (the contract's `MIN_NONCE_LENGTH`; it used to abort
  with `E_INVALID_NONCE` after the user had signed and paid) and derives `consume` vs `consume_soulbound`
  from `cfg.nftType`. `cfg.soulbound`, when set, is only a cross-check and throws if it disagrees; a
  soulbound `nftType` with `soulbound` unset used to build the transferable `consume`, which aborts.
- `minimumPaidPriceMist` saturates at u64::MAX like `min_paid_price_mist`; it and `commissionForPrice` route
  their inputs through `toU64`, so an unsafe number or out-of-range value throws instead of previewing a
  different amount.
- `fetchOwnedGates` reads gates with at most 10 requests in flight (an operator with thousands of caps used to
  fire thousands at a public full node).
- **Breaking (pre-v0.2):** `abortMessage(error, originalId)` requires `originalId`. Without it any package's
  `access_gate` abort was claimed. The error-chain walk is bounded (a two-object cycle overflowed the stack).

### Added

- Drift checks against the chain (weekly, read-only, no secrets): every struct the parsers decode or read has
  exactly the recorded fields (`tests/schema.ts`), a real event of each kind decodes strictly, and every
  builder's Move function has the recorded reference kind and type per parameter (`EXPECTED_PARAMS`), not just
  the same arity. Offline, a schema-driven encoder (independent of `src/events.ts`) must round-trip through the
  real parsers, trailing bytes included, and each builder's pure/object argument kinds must match.

### Changed

- CI builds the declarations, checks the tarball's file list and runs lint without `--if-present`; the tag
  workflow runs the same workflow as CI (lint and the build were missing there). `SECURITY.md` ships in the
  package.
- Documentation: the version table, `platformConfigId` (read by purchase and consume, not only purchase) and
  `abortMessage`.

## [0.0.6] - 2026-10-08

### Changed

- `@mysten/sui` is a **peer dependency** (`^2.33.2`) and a dev dependency, so a host has exactly one
  copy (the builders return `Transaction` instances); `npm ls --all` runs in CI.
- Event decoding is **strict**: BCS bytes that do not re-serialise to themselves (a trailing field
  from a later upgrade, a mismatched layout) throw instead of decoding silently.
- `accessGateDeployment` no longer resolves `constructor`, `toString`, `__proto__` etc. as networks.
- A missing `locked_commission` key is malformed (`parseGate` returns `null`), not "no lock"; only an
  explicit `null` (or `{ vec: [] }`) is none.
- `readIndexerEvents`: `path` must be relative and stay on the indexer's origin, redirects are
  refused, responses are `no-store`, and the body is capped in **bytes** while it is read.
- Indexer rows are untrusted: a malformed or undecodable row is skipped and counted
  (`AccessGateEventPage.invalidRows`), so one bad row cannot break the feed's pagination. Full-node
  rows still throw (real drift).

### Added

- `.github/workflows/live-read.yml`: the read-only testnet suite (ABI arity, real events, the
  pass-variant rendering) runs weekly in CI.

## [0.0.5] - 2026-10-08

### Changed (breaking)

- `OwnedAccessNft.usesRemaining: number | null` is replaced by `variant: PassVariant`, a discriminated
  value: `{ kind: 'unlimited' } | { kind: 'singleUse', remaining: bigint }`. `null` no longer means both
  "unlimited" and "unknown", and the u64 count is exact (it used to saturate at `MAX_SAFE_INTEGER`).
- The variant is read from the rendering a full node actually returns (`{ "@variant": ... }`, pinned
  against a real testnet pass by the live test). A pass whose variant cannot be parsed is rejected by
  `parseOwnedAccessNft`, so it is absent from `fetchAccessNfts` and never counts as access.
- `ownsAccessNft` counts only usable passes by default (unlimited, or single-use with uses left); pass
  `{ usable: false }` to count every pass of the type. An exhausted receipt no longer grants access.

### Added

- `isUsablePass(nft)` and the `PassVariant` type.

## [0.0.4] - 2026-10-03

### Fixed

- **Recipient addresses must be complete.** `buildCreateGateTx` (`paymentRecipient`),
  `buildSetPaymentRecipientTx` and `buildAirdropTx` refuse anything but `0x` followed by 64 hex
  digits. `tx.pure.address` zero-pads short hex, so a truncated paste was encoded as a different,
  unowned address. New export `toAddress`.

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
