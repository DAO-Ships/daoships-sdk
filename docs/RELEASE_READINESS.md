# SDK initial-release readiness

Reviewed 2026-09-10. This is the current release audit; earlier audit documents preserve
historical findings and test counts. Scope is the DAOShips SDK and its contract, indexer
and app integrations. No DAOShips product CLI was built.

The SDK covers the current protocol ABI and public indexer surfaces. Release tooling,
recovery adapter acceptance, IPFS routing, canonical profile ordering and an executable
Orchard harness are implemented. Live funded acceptance and operational rollout remain
required. Coverage and source parity do not establish freedom from vulnerabilities.

## Release hardening implemented

| Area | Current behavior |
| --- | --- |
| Durable recovery | Public store/executor conformance helpers test independent adapters, atomic CAS, exact bigint persistence, identity immutability and callback ordering. A disposable fsynced reference backend is exercised with competing processes, killed writers, lost acknowledgements and restart. It is test support, not a production database dependency. |
| npm preparation | Pinned GitHub Actions prepare Node 22/24/26 CI, immutable sibling-source acceptance, tagged public publication and npm provenance through OIDC. Release metadata and successful source acceptance on the same SDK commit are required. Publication remains disabled pending repository/license ownership. |
| IPFS | ABI/bytecode resources default to `ipfs.qu.ai`; other content defaults to `ipfs.io`, with explicit overrides. Reads bound body size, parsing complexity, time and cancellation. Bytecode requires an independently trusted keccak256 hash. JSON/ABI results distinguish gateway retrieval from trusted raw-byte SHA-256 verification. |
| Hosted realtime | A real testnet checkpoint channel delivered changes, recovered from a forced socket interruption, refreshed snapshots and removed all channels. The adapter still treats realtime as invalidation and refetches authoritative rows. |
| Profile order | The indexer records actual transaction/log positions for new Poster events. An additive migration and receipt-verified backfill are prepared. SDK ordered reads are opt-in; legacy schemas remain compatible, and unknown historical order remains explicitly incomplete. Accepted banner/theme-only vault posts also establish DAO profile authority, preventing later launcher overwrite. |
| App artifact parity | All eight app navigator creation artifacts match source-verified compiler output. Onboarder, ERC20Tribute, NFTGated and Signal copies were updated, with matching metadata CID fixtures. This does not claim already deployed contracts changed. |
| Native Quai workflows | Navigator plans can explicitly include the four-byte CREATE suffix and nonce used by pinned quais, and verify the corresponding predicted address. Exact calldata validation retains the reviewed suffix. Existing local EVM workflows remain supported. |
| Orchard acceptance | An explicit chain-15000 harness implements all three launch routes, all eight governance activations, non-owner Budget activation, durable intermediate transaction IDs and restart reconciliation. Separate recovery scenarios cover stale preparation, rejected signing and an injected lost broadcast acknowledgement. Keys are only read in explicit execute mode. |

See [adapter conformance](ADAPTER_CONFORMANCE.md), [npm release](NPM_RELEASE.md),
[IPFS reads](IPFS.md), [Supabase](SUPABASE.md), [data integrations](DATA_INTEGRATIONS.md)
and [Orchard acceptance](ORCHARD_ACCEPTANCE.md) for concrete usage and guarantees.

## Live observations

- Hosted mainnet previously passed 25 table projections/counts and sample DAO/member joins
  in 61 bounded read requests. Fresh testnet schema checks passed in 67 reads.
- At 2026-09-10 22:45:25 UTC, the Orchard head was 7,774,851 and the testnet checkpoint
  was 7,774,850: one block behind, with its block hash matching the canonical RPC block.
  The checkpoint was approximately 1.2 seconds old; syncing and reindex flags were false.
  All 25 table projections/counts and sampled DAO/member/proposal joins passed.
- The previously stale testnet checkpoint is advancing again. The latest realtime run
  passed the connector's five-minute age policy and observed two changes, two subscriptions
  and four snapshots across a forced reconnect; cleanup left zero channels. Checkpoint
  timestamp freshness alone does not prove the indexer has caught up to the chain head.
- Read-only Orchard preflight confirmed chain 15000 and code at the configured combined
  launcher, but its `daoShipLauncher()` call (selector `0x327d5135`) failed with
  `CALL_EXCEPTION`. The harness rejects execution until the intended deployed graph is
  established. The hosted testnet checkpoint independently passed identity/freshness.
- `ipfs.qu.ai` returned the current Onboarder metadata, including 39 ABI fragments, with a
  raw-byte SHA-256 matching the independently compiled metadata.
- `ipfs.io` returned HTTP 429 with a 900-second retry delay. Its
  [public notice](https://gatewaychanges.ipfs.io/) announces retirement on September 21,
  2026. The requested content default is retained pending a replacement decision.

Many feature tables were empty in the earlier hosted samples. Their projections were
accepted but live row/business validation remains unexercised. No public-chain transaction,
live database migration/backfill, indexer service deployment or npm publication was
performed in this hardening work. The realtime check did not induce a reorg or write rows.

## Remaining release gates

1. Resolve the configured Orchard launcher getter failure, then run the reviewed configuration with dedicated funded wallets; retain receipts,
   contract identities and restart evidence. Native shard behavior, replacement races,
   provider diversity and finality still require live validation.
2. Apply the indexer ordering migration before deploying the updated handler, then preview
   and apply the bounded historical backfill. The indexer repository's
   `docs/RECORD_EVENT_ORDER.md` gives the exact procedure. Enable `recordOrdering: true`
   only when the service supports it. Existing missing evidence is never invented. Older incorrect profile-authority flags or
   launcher overwrites require a separate canonical-history repair; the position backfill
   does not repair materialized metadata.
3. Select the SDK repository and license, configure npm scope ownership and the trusted
   publisher/environment, and run the prepared workflows on hosted infrastructure.
   `private: true` intentionally keeps premature publication blocked.
4. Replace the retiring `ipfs.io` content default and repeat live gateway acceptance.
5. Complete populated indexer scenarios and keep verifying chain-head catch-up. Real reconnect
   delivery is now observed; real reorg reconciliation remains controlled-test evidence.
6. Run conformance and backend failure acceptance against each integrator's actual durable
   database/executor. The supplied reference process suite cannot certify other backends.
7. Broader browser/wallet compatibility remains a target-integration matrix. The current
   app production bundle and Node ESM tests provide narrower evidence.

No missing current ABI method/event or public indexer table was identified. Dedicated
preflight and receipt conveniences do not cover every generic contract call. Generic
callers must verify authorization and business outcomes; a successful receipt can include
an unsuccessful DAO proposal action.

## Validation

The integrated release checks cover behavioral coverage and negative consumer types,
isolated tarball consumption, ABI/type/schema/bytecode parity, all three local Solidity
suites and real-process adapter faults. Coverage thresholds remain 95% lines, 85% branches
and 95% functions; generated ABIs/bytecodes are checked against source separately.

Current source parity: 17 interfaces, 353 functions, 103 events, 14 concrete contracts,
291 compiled methods and eight navigators. All 25 public indexer tables are represented:
346 default projection columns plus two optional canonical record-order columns.

Final behavioral validation passed 309 tests with no failures, skips or TODOs.
The preceding coverage run passed 307 tests; two release-script guards were added and
passed afterward, without runtime source changes. Coverage was 98.58% lines, 93.69% branches and 98.99% functions. All three local Solidity
suites and all 13 real-process adapter scenarios passed. The packed consumer validated
all five exports, 78 emitted modules/declarations and 62 portable documentation links.
The package gate caught two sibling-only documentation links; both were corrected and
the gate passed on rerun. The source parity gate also passed. Fresh-registry tarball installation passed with
lifecycle scripts disabled, and the npm advisory check reported zero known vulnerabilities.

Standalone copied-checkout tests passed on Node 22.23.2 and 24.21.0: 307 behavioral tests
passed, with only the two explicitly optional sibling-source checks skipped because those
repositories were absent. Both runtimes also passed all 13 process/crash scenarios. Their
source checks were exercised separately in the full workspace. The main run used Node
26.8.1. GitHub workflow YAML parsed successfully; actual hosted workflow/OIDC execution
remains a repository-setup requirement.

The affected app artifact/validation suites passed 47 tests and its production TypeScript/
Vite build passed. The indexer passed 454 unit tests plus source/backfill typechecks.
The app build reports existing large-chunk advisory output; no size reduction claim is made.

## Intentional boundaries

DAO governance activates every navigator, including Budget's vault module grant.
Existing-vault bootstrap still requires owner authorization before the DAO is operational.
The application executor may use `quaivault-sdk`; this SDK has no such dependency and
continues to have only pinned `quais@1.0.0-alpha.53` at runtime.

Wallet custody, production storage services, IPFS pinning, vault-owner consensus,
singleton infrastructure deployment, automatic transaction replacement and nonce-gap
filling remain application responsibilities. Adapters and explicit recovery APIs expose
those boundaries without silently resending uncertain transactions.
