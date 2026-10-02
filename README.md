# @meddleware/access-gate-client

[![npm](https://img.shields.io/npm/v/@meddleware/access-gate-client)](https://www.npmjs.com/package/@meddleware/access-gate-client)
[![licence: 0BSD](https://img.shields.io/badge/licence-0BSD-blue)](LICENSE)

The TypeScript client for the [`access_gate`](https://github.com/meddleware-org/access-gate-sui) Move
package: typed reads of gates, access NFTs and the platform config; typed events; transaction
builders; abort messages; and the deployed package and object ids.

It talks to a Sui full node over gRPC (`SuiGrpcClient` from `@mysten/sui`). The gateway challenge
and proof wire protocol is in [`@meddleware/nft-gate-client`](https://github.com/meddleware-org/nft-gate-client).

```bash
npm install @meddleware/access-gate-client @mysten/sui
```

## Ids

`access_gate` has two package ids per network, and they differ once the package is upgraded:

- **`originalId`** — where the types and events are defined. Reads, type strings and event queries
  use it.
- **`publishedAt`** — the latest version. Transactions call it (`packageId` in the builder configs).

Both, and the shared `PlatformConfig` id, come from the `deployments` subpath. It is generated from
the `Published.toml` and `deployments.json` that `@meddleware/access-gate-sui` publishes, so no app
copies an id by hand:

```ts
import { accessGateDeployment } from '@meddleware/access-gate-client/deployments'

const { originalId, publishedAt, platformConfigId } = accessGateDeployment('testnet') // throws if unknown
```

## Reads

```ts
import { SuiGrpcClient } from '@mysten/sui/grpc'
import {
  accessNftType,
  fetchAccessNfts,
  ownsAccessNft,
  fetchOwnedGates,
  fetchGate,
  fetchPlatformConfig,
  ownsPlatformAdminCap,
} from '@meddleware/access-gate-client'

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: 'https://fullnode.testnet.sui.io:443' })
const nftType = accessNftType(originalId, /* soulbound */ false)

await ownsAccessNft(client, owner, nftType, gateId) // stops at the first match
await fetchAccessNfts(client, owner, nftType, gateId) // every page
await fetchOwnedGates(client, operator, originalId) // the gates an address administers
await fetchGate(client, gateId, originalId)
await fetchPlatformConfig(client, platformConfigId, originalId) // version, treasury, commission, fees
await ownsPlatformAdminCap(client, address, originalId)
```

Every parser compares the object's full type, normalised, with the expected
`<originalId>::access_gate::<Name>`. A same-named struct in another package does not match. Owned-object
reads follow the cursor to the last page. A list longer than `MAX_OWNED_PAGES` pages throws rather
than being cut short.

## Events

```ts
import { listAccessGateEvents } from '@meddleware/access-gate-client'

const page = await listAccessGateEvents(client, {
  originalId,
  kinds: ['AccessMinted', 'AccessConsumed'], // default: all seven
  gateId, // optional
  limit: 20,
  indexer: { url: 'https://sui-indexer.meddleware.co.uk', network: 'testnet' }, // optional
})
page.events // newest first, typed per kind (e.g. AccessConsumed.consumer, .nonce)
page.cursor // pass back as `cursor` for older events
```

- Events are decoded from their **BCS bytes**, which are the same on every transport.
- With `indexer`, the first page is read from a read-indexer. If the indexer fails or takes longer
  than 3 s, the page comes from the full node instead, and `indexerError` says why.
- A cursor stays with the source that issued it.
- Indexer rows are decoded and type-checked like full-node events. The indexer URL must be `https:`
  (`http:` only for a loopback host); `readIndexerEvents` is the shared reader.
- Indexer data is for display. Never use it to authorise anything.

## Transactions

```ts
import { buildPurchaseTx, buildConsumeTx, buildCreateGateTx } from '@meddleware/access-gate-client'

const gate = { packageId: publishedAt, gateId, platformConfigId, nftType, soulbound: false }
const tx = buildPurchaseTx(gate, priceMist)
```

- There are builders for purchase, consume, create, every `AdminCap` setter, airdrop, make-free
  and freeze.
- Commission helpers (`commissionForPrice`, `gateCommissionMist`, `minimumPaidPriceMist`) mirror
  the contract's arithmetic.

## Errors

```ts
import { abortMessage } from '@meddleware/access-gate-client'

try { /* sign and execute */ } catch (e) {
  show(abortMessage(e, originalId) ?? String(e))
}
```

- `abortMessage` finds an `access_gate` abort in an SDK `ExecutionError`, a `SimulationError`, a
  failed transaction's status, or error text from the SDK or a wallet.
- It returns the user-facing message for codes 1–14 (`ACCESS_GATE_ABORTS`); 13 (`E_WRONG_VERSION`)
  means the called package version has been retired — rebuild against the current `publishedAt`.
- Aborts from other modules or packages return `null`.

## Development

```bash
npm ci
npm run type-check && npm run lint && npm test
npm run check:deployments        # src/deployments.ts matches @meddleware/access-gate-sui
GRPC_TESTNET=1 npm run test:integration   # live reads + ABI drift against public testnet
```

After bumping `@meddleware/access-gate-sui`, run `npm run gen:deployments` and commit the result.
CI fails if the two differ.

## Licence

BSD Zero Clause (`0BSD`) — see [LICENSE](LICENSE).
