# AGENTS.md — @meddleware/access-gate-client

## Package identity

| Field | Value |
| --- | --- |
| npm name | `@meddleware/access-gate-client` |
| Version | see `package.json` |
| Licence | 0BSD |
| Type | TypeScript source package (declaration-only build) |
| Runtime targets | Node.js ≥ 22, browsers (via Vite), Cloudflare Workers |
| Runtime dependency | `@mysten/sui` `^2.33.1` |

## Layout

```text
src/
├── index.ts        — public re-exports
├── deployments.ts  — GENERATED ids per network (subpath `./deployments`)
├── typeNames.ts    — full type strings, exact normalised matching
├── types.ts        — object, event and structural client types
├── ownership.ts    — paged owned-object reads; access NFTs
├── gates.ts        — AdminCaps, Gates, PlatformConfig, PlatformAdminCap
├── events.ts       — BCS event decoding, listAccessGateEvents (full node / indexer)
├── aborts.ts       — ACCESS_GATE_ABORTS, abortMessage
└── ptb.ts          — transaction builders, commission arithmetic
scripts/gen-deployments.mjs — writes/checks src/deployments.ts from @meddleware/access-gate-sui
tests/              — vitest unit tests; tests/integration — live testnet (GRPC_TESTNET=1)
```

## Commands

| Task | Command |
| --- | --- |
| Type-check | `npm run type-check` |
| Lint | `npm run lint` |
| Unit tests | `npm test` |
| Live testnet reads | `GRPC_TESTNET=1 npm run test:integration` |
| Regenerate ids | `npm run gen:deployments` |
| Check ids | `npm run check:deployments` |
| Build `.d.ts` | `npm run build` |

## Rules for agents

- Read [CLAUDE.md](CLAUDE.md) first; its invariants are binding.
- Changes to `access_gate` structs, events or abort codes in `access-gate-sui` need the matching
  change here in the same release.
- Never hand-edit `src/deployments.ts`.
- Releases: bump `version`, push, tag `v<version>`. `npm-publish.yml` publishes via npm trusted
  publishing.
