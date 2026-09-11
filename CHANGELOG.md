# Changelog

## 0.1.0-alpha.3

- Correct proposal offering preflights for Quai's EVM clock: read voting power at
  the verified parent work object's timestamp minus one, while keeping state reads
  pinned to the selected block. Reject missing, mismatched or invalid parent headers.
  Found during funded Orchard CLI governance testing.

## 0.1.0-alpha.2

- Harden navigator deployment receipt parsing with shared limits and correct unknown
  outcomes; validate bounded simulation results throughout chain/deployment preparation.
- Enforce recovery, confirmation, coordination and conformance deadlines after event
  loop stalls, preserving ambiguous-send handling and unused nonce cleanup.
- Consolidate IPFS/indexer stream readers, bound chunk retention, copy reused buffers
  and yield for cancellation. Isolate request headers and bound nonce parsing input.
- Add 12 security/stability regressions and record the full SDK audit and verification.
- Export `DaoShipsProvider` so SDK consumers and the acceptance harness use the same
  exact-nonce workaround for pinned quais on mainnet and testnets, including prefetched
  block transactions. Retain `OrchardProvider` as a compatibility alias and add a
  captured mainnet transaction/block regression.
- Execute all 228 DAO/navigator functions against local Solidity: 163 reads and
  65 writes, with a runtime ABI completeness gate. Add sponsorship/batch votes,
  permission locks/revocation, recovery withdrawals, emergency controls, manager
  rotation, batch rollback, Merkle overloads, subscription gifts and grace boundaries.
- Document remaining live business, boundary and workflow-helper coverage gaps.

- Fix default contract read senders: use the zero address instead of the target
  contract, which Orchard rejects as a non-EOA sender. Explicit read callers and
  transaction simulation senders are preserved.
- Add wallet-free Orchard readiness and a one-account, resumable transaction smoke
  command using `ORCHARD_PRIVATE_KEY` in an ordinary `.env` or environment variable.
- Allow ordinary dotenv syntax and environment keys in the full Orchard harness.
- Fix harness compatibility with pinned quais: use `populateQuaiTransaction` and
  normalize hexadecimal transaction nonces before the provider's decimal formatter.
- Supply the explicit Cyprus-1 node location required by pinned-quais log queries.
- Record the first successful funded Orchard smoke transaction and restart recovery.
- Make live governance timing explicit: wait for usable vote snapshots, use a
  180-second fixture window, retain reverted votes and reviewed proposal retries.
- Match populated Orchard DAO/member, navigator, proposal/vote and Signal Poster
  rows to the suite's receipts after the public indexer catches up.
- Record the completed two-wallet Orchard run: three launch routes, eight navigator
  activations, non-owner Budget, populated indexer checks and recoverable RPC timeouts.

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
