# Changelog

## 0.1.0-alpha.1

- Publish from matching GitHub version tags through npm trusted publishing.
- Require source acceptance on the exact tagged commit and publish the verified test archive.
- Serialize release runs and document the tag-based release procedure.

The SDK runtime API and known alpha limitations are unchanged from `0.1.0-alpha.0`.

## 0.1.0-alpha.0

Initial DAOShips SDK alpha for early application, service and agent integration.

- Typed coverage of 17 contract interfaces and all 25 public indexer tables.
- DAO governance, membership, tokens, treasury, metadata and eight navigator integrations.
- Three launch routes and governance-based navigator activation with immutable plans,
  explicit confirmation depth, receipt/postcondition verification and native Quai CREATE suffix support.
- Recoverable ordinary transactions, atomic persistence contracts, nonce coordination,
  explicit ambiguous-send handling and reusable store/executor conformance checks.
- Hosted Supabase publishable-key integration with explicit network and freshness checks;
  bounded data joins and realtime invalidation/reconciliation.
- Contract IPFS reads through ipfs.qu.ai, content reads through ipfs.io, configurable gateways,
  bytecode hash verification and optional canonical profile record ordering.
- Node ESM package, TypeScript declarations, isolated tarball acceptance, local Solidity tests,
  process/crash scenarios and a repository-only Orchard acceptance harness.

Known alpha limits: funded Orchard scenarios are not yet complete, and the configured
combined launcher fails its daoShipLauncher() getter during live graph verification.
Optional record ordering requires the upstream migration/backfill. ipfs.io announces
retirement on September 21, 2026; integrations can override the content gateway.
