# Security Policy

## Scope

This policy covers the `@meddleware/access-gate-client` package source (`src/**`):

- the read parsers;
- event decoding and the indexer fallback;
- the transaction builders;
- the abort table;
- the generated deployment ids.

It does not cover:

- the `access-gate-sui` on-chain package (see that repo's `SECURITY.md`);
- the `nft-gate` gateways, which verify access server-side;
- the `sui-indexer` service;
- the `@mysten/sui` SDK (report upstream to [Mysten Labs](https://github.com/MystenLabs));
- the caller-supplied wallet, signer and RPC endpoint.

## Security model (invariants)

A report showing any of these violated is in scope and treated as high severity.

1. **Exact type matching.** An object or event is accepted only if its normalised full type
   equals `<originalId>::access_gate::<Name>`. A look-alike package cannot pass as `access_gate`.
2. **No silent truncation.** Owned-object reads either return every page or throw. A holder is
   never reported as not holding because a list was cut short.
3. **Ownership checks are authorisation-grade.** `ownsAccessNft` counts only usable passes (unlimited, or
   single-use with uses left) unless the caller passes `{ usable: false }`. A pass whose `AccessVariant`
   cannot be parsed (unknown tag, missing or non-u64 count) is rejected, never read as unlimited.
4. **Indexer data is display-only.**
   - Indexer rows are decoded and type-checked like full-node events.
   - They are never used to authorise.
   - A gateway or contract must not treat `listAccessGateEvents` output as proof of anything.
5. **Ids come from the published deployment records.** `src/deployments.ts` is generated from
   `@meddleware/access-gate-sui` and drift-checked in CI.
6. **No keys or secrets.** Signing is delegated to the caller's wallet.

## Supported versions

Only the latest published npm version receives security fixes.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Email **<security@meddleware.co.uk>** with:

- a description and its impact;
- steps to reproduce or a proof of concept;
- the package version or commit SHA.

You will receive an acknowledgement within **3 business days**. Confirmed issues get a resolution
plan within **14 days**. Critical issues (CVSS ≥ 9.0) are acknowledged the same day.

## Disclosure

Once a fix is released, a security advisory is published on the GitHub repository. Reporters are
credited unless they prefer to remain anonymous.
