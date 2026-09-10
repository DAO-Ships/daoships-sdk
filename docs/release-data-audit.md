# Initial release data audit — 2026-09-10

The SDK's public indexer projections cover all 25 public tables and 346 columns in the current indexer schema. This review found and fixed four stability/security defects; it did not establish production service availability or independently authenticate indexer claims.

## Fixed findings

| Severity | Finding and impact | Resolution and evidence |
| --- | --- | --- |
| Medium | Latest DAO/member profiles used block timestamps plus hash-based IDs to select one record. Multiple updates in one block could return obsolete record-only metadata as complete, potentially causing a later profile update to overwrite newer fields. | `src/data-integrations.ts:179` now inspects two newest eligible records by SQL block number, using at most two requests to tolerate server page caps. Equal or missing block numbers produce `profile: null`, `profileAmbiguous: true`, `profileReason: 'ambiguous-record-order'`, and `complete: false`. Materialized DAO fields remain available. Regression covers same-block records, missing block numbers, capped pages and adjacent block numbers above JS safe precision. |
| Medium | `waitForIndexedBlock` reread caller-owned chain/freshness/abort options after awaiting, so edits could weaken the original requirement or misclassify cancellation. | `src/indexer-sync.ts:107` captures options before waiting. Regressions change chain, freshness and abort settings while the reader is pending. |
| Medium | A timed-out asynchronous realtime observer could remain pending while the next invalidation started another callback, accumulating unbounded work despite intended backpressure. | `src/data-integrations.ts:366` tracks active delivery and closes/unsubscribes when an observer remains pending at the deadline. Regression holds an observer indefinitely and proves later invalidations cannot create additional deliveries. |
| Low | Synchronous custom readers/fetch implementations could block timer delivery, then return success after the advertised deadline. | `src/indexer.ts:257` and `src/indexer-sync.ts:133` check elapsed monotonic time before accepting success. Regression covers GET, HEAD and checkpoint waits with blocking adapters. |

IPFS retrieval also avoids one redundant full Merkle-tree validation. It still validates the entire tree, compares its root with the caller's chain read, verifies the derived proof, and rereads the chain root after retrieval. No transport or hashing dependency was added.

## Cross-project checks

- Compared `indexer-models.ts` with `daoships-indexer/supabase/migrations/schema.sql`, including numeric and array columns, SQL nullability, public-table completeness, and exclusion of the two internal tables. Added `scripts/check-indexer-schema.mjs` to make this a repeatable workspace check. Unknown column types and unsupported column alterations fail for review.
- Reviewed `daoships-indexer/src/handlers/poster.ts` and `daoships-app/src/services/indexer/RecordIndexerService.ts` for profile author/trust rules, initial-profile restrictions, member records, vote reasons and metadata replacement behavior.
- Rechecked typed filter/query injection boundaries, exact NUMERIC/BIGINT casts, response byte/depth/node limits, cancellation, iterator request limits and repeated-page detection.
- Rechecked Poster input serialization limits, plain-property validation, URL protocols, allowed schemas, profile clear/preserve semantics, allowlist tree/proof correspondence, gateway redirect isolation, pinning claims, realtime reconciliation and cleanup.

## Remaining boundaries and release acceptance

1. **Authoritative intra-block metadata order is an indexer schema gap.** `ds_records` stores `block_number`, `created_at` and transaction hash, but lacks transaction/log ordering columns. The handler uses the block timestamp for `created_at`; its hash-based ID is not execution order. The SDK now reports ambiguous profiles as incomplete. Applications must resolve canonical chain logs before constructing a profile update from such a result. A schema/handler change can later remove this limitation; no sibling project was changed here.
2. **Cross-table snapshots are not atomic.** Matching before/after checkpoint hashes indicate observed checkpoint stability, not a database transaction or proof that no write occurred between reads. The API exposes `atomic: false`, completeness budgets and `trust: 'indexer-claims-only'`. Transaction authorization still requires chain verification.
3. **Metadata remains untrusted content.** Historical member trust is an indexer assertion, not proof from current balances. Vote reasons require a matching indexed vote. IPFS results are verified against the caller's chain root; a pinning adapter's CID alone does not prove availability, persistence or content addressing.
4. **Live service acceptance remains outstanding.** Real Supabase publication/RLS/reconnect behavior, PostgREST schema configuration and gateway/pinning availability need testing against the intended release environment. Offline tests use controlled transports and do not publish data. Custom callbacks that ignore cancellation cannot be forcibly terminated; a hung realtime observer now causes the watch to close.

## Validation

The audit's full runner completed with **267 tests passing, zero failures** (concurrent peer additions present at that run included). Coverage restricted to the six reviewed modules measured **98.71% lines, 94.23% branches and 96.94% functions**; `data-integrations.js` measured 100% lines. The focused changed areas passed 13 indexer audit tests, 8 checkpoint tests and 19 data-integration tests. `node scripts/check-indexer-schema.mjs` verified all 25 public tables and 346 columns. These are point-in-time results; the consolidated release audit records the final whole-project validation after all agents finish.

The sibling indexer and app working trees remained clean. No CLI, runtime dependency, public-network write or sibling-project edit was introduced.

## Authorized upstream ordering follow-up

Following this audit, upstream changes were explicitly authorized and implemented in `daoships-indexer`: nullable transaction/log coordinates, an idempotent migration, actual-position Poster writes, and a targeted canonical-receipt backfill. The SDK now supports optional ordered-record queries and deterministic same-block profile selection when sufficient coordinates are present. Its baseline projection remains compatible with the hosted schema; unknown/mixed legacy positions still fail conservatively. The current source check covers 348 columns (346 baseline plus two opt-in fields). Upstream source and maintenance-script typechecks and all 452 indexer unit tests passed. See ordering rollout (indexer repository: `docs/RECORD_EVENT_ORDER.md`). The migration, backfill and service deployment remain prepared, not applied; earlier clean-tree/no-sibling-edit statements describe the original audit scope.
