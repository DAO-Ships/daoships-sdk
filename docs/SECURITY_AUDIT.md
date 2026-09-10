# SDK security and stability audit

Date: 2026-09-09. Subsequent workflow corrections and latest verification are recorded in
the [final integration review](FINAL_INTEGRATION_REVIEW.md).
Scope: this SDK and its correspondence to local DAOShips contracts,
app artifacts and indexer schema. Three parallel reviewers covered transactions/chain,
protocol domains and indexer/packaging, with a separate cross-review of shared ABI and
event validation. This is an internal engineering audit with executable regression
evidence, not an independent security certification.

The checked-in protocol surface is represented in the SDK: 353 ABI functions and 103
events across 17 interfaces, all eight navigator constructors and creation bytecodes,
and all 25 public indexer tables. Source verification covers 116 directly declared
public/external functions and 291 compiled methods, including inherited methods and
getters, across 14 concrete DAOShips contracts. External vault interfaces are snapshots;
their production implementation and owner-consensus execution are separate acceptance gates.
Method availability does not mean every application workflow has dedicated orchestration,
preflight checks or exhaustive state-transition tests.

## Findings corrected

Severity describes potential SDK integration impact and assumes the reproducing conditions
in each sub-audit; it is not a CVSS score or a claim that a deployed exploit occurred.

| Priority | Finding | Correction and evidence |
| --- | --- | --- |
| High | Quais accepted JavaScript `"false"` as a truthy ABI boolean, encoding a yes vote; sparse flags could become false. | Recursive strict ABI validation requires real booleans, bigint integers, dense data arrays, correct tuple/array shapes and integer widths before encoding. Regression tests reproduce both cases. |
| High | Mutated preparation input or an estimator-mutated request could change the transaction after an asynchronous boundary. | Capture primitive intent and nested vote inputs before awaits, isolate estimation requests, rebuild the final broadcast request and capture persistence callbacks. Tests mutate inputs while RPC is pending. |
| Medium | Wallet/network switching during gas estimation was unchecked; number-pinned reads could silently span a reorg. | Recheck signer/provider/network immediately before broadcast; verify block hash and network after read batches/preparation. These checks cannot lock an external signer or prevent later reorgs. |
| Medium | Unknown receipt outcomes were described as reverted; mismatched confirmation hashes were not rejected. | Only status 0 is reverted and 1 successful. Unknown outcomes stay `TX_PENDING`; mismatched supplied hashes fail. No automatic resubmission occurs. |
| Medium | Hung or large provider/HTTP responses and deeply nested metadata could consume unbounded resources. | Bound RPC waits, ABI input/output, streamed Fetch bytes, JSON traversal, iterator requests, event/revert decoding, Poster content and Merkle processing. Adversarial tests cover inclusive limits, abort races, cycles, malformed UTF-8 and deferred ABI failures. |
| Medium | Indexed dynamic event values were typed as recoverable plaintext. | Generated event types use quais `Indexed` for dynamic indexed values. Poster tag consumers use `.hash`. Runtime and negative TypeScript assertions verify the contract. |
| Low | Exported ABI/schema tables were mutable; error diagnostics could invoke getters. | Deep-freeze canonical tables; diagnostic traversal only reads own data properties under depth/node/byte limits. This is defensive validation, not a sandbox against arbitrary application code. |
| Low | PostgREST quoting changed literal control characters; compact projections rejected legitimate SQL nulls; future/frozen checkpoint clocks appeared fresh. | Preserve quoted literals, align nullable fields with SQL, reject implausible future checkpoints and advance explicit clocks while polling. |
| Low | Poster/allowlist inputs could change meaning during serialization; full navigator configs failed quote validation; mining progress options delayed cancellation. | Reject malformed structures before expensive work, validate pricing fields specifically and yield mining work at a bounded interval. |

Detailed reproductions, limits and residual risks:
[transactions and chain](audit-transactions.md), [protocol domains](audit-protocol.md),
[indexer](audit-indexer.md), [packaging and source coverage](audit-packaging.md).
Shared contract/event regressions are in `test/audit-contracts.test.mjs`.

## Repeatable validation

| Command | Assurance |
| --- | --- |
| `npm test` | Build, positive/negative TypeScript consumer checks, and every offline test in one node:test process. |
| `npm run test:coverage` | Same tests with minimum aggregate coverage of 95% lines, 85% branches and 95% functions. Use Node 24+ or a recent Node 22 with coverage threshold flags. |
| `npm run test:package` | Actual tarball extracted into a temporary consumer, all five ESM subpaths, strict declaration checking, module graph and portable documentation links. Runtime filesystem permissions exclude SDK source/dist and sibling projects. Uses the installed quais dependency tree, not a fresh registry installation. |
| `npm run check:source` | ABI hashes, generated types, navigator artifact provenance, full compiler ABI/method-identifier parity and current source dependency closure for 14 concrete contracts. Requires sibling sources/artifacts. |
| `npm run test:contracts` | SDK-driven local Solidity execution for three launch paths, governance and all eight navigators. Requires sibling Hardhat dependencies/artifacts; uses an isolated EVM with vault/asset test doubles. |
| `npm run validate` | Coverage and packed-consumer checks. |
| `npm run validate:workspace` | All validation commands including required source and local-contract checks. |
| `npm audit` | Registry advisory lookup for pinned production and development dependencies; network required. |

The initial audit's offline suite contained 143 passing tests with zero skips in this workspace,
including 48 new adversarial regression cases. Node 26.8.1 coverage is 97.93% lines,
90.78% branches and 97.74% functions. Generated ABI/creation-bytecode data are excluded
from these percentages; their contents receive separate source/type parity checks.
Coverage is measured over loaded runtime modules, not a proof of all possible paths.
The full suite also passes on the declared minimum Node 22.0.0 and on Node 24.0.0;
the latter produces the same coverage percentages and passes the coverage gates.

The local Solidity suites additionally pass all three launch paths, governance minting,
failed-action rollback and defeated closure, Shares/Loot permit signatures and rejection
paths, native/ERC20 ragequit payouts, and all eight navigator deployments/lifecycles.
Additional navigator paths cover Merkle multipliers, permit onboarding, subscription
conversion/rewards/re-enrollment, vesting revocation, timelock cancellation and ERC20
budget batches/rollover/ceilings. These executable scripts are separate from the 143
node:test cases and do not contribute to the unit coverage percentages.

The npm advisory check on this date reported zero known vulnerabilities across the
installed production and development dependency graph. The pinned alpha quais dependency
still requires compatibility and supply-chain review for a release; an empty advisory
response does not establish its security.

During validation, this sandbox suppressed worker-process test details. The SDK test
entrypoint now directly imports every test file in one process and reports actual test
cases. Package subprocess failures are checked explicitly. Validation does not force an
early process exit that could conceal open resources.

## Integration changes to review

- JavaScript callers must supply bigint ABI integers, actual booleans and dense positional
  arrays. Values formerly coerced by the ABI library now fail with `INVALID_ARGUMENT`.
- Dynamic indexed event fields are `Indexed` objects, including Poster `NewPost.tag`.
- Compact indexer balance/status fields now correctly include `null` in their types.
- Bounded inputs and responses can reject unusually large legitimate workloads. Configure
  supported budgets deliberately; allowlist limits are SDK resource limits, not on-chain
  limits. A custom Fetch shim exposing only `json()` owns its buffering limits.
- Observed reorgs, unknown receipt statuses and provider/account changes fail conservatively.
  Retain intent and transaction hashes and reconcile outcomes before deciding to retry.

## Remaining release gates

The package remains private and alpha. Live Quai RPC/shard signing, wallet acceptance,
hosted PostgREST casts and indexer convergence, production QuaiVault owner consent,
replacement/nonce coordination, and target deployment identity are not certified here.
The local execution suites cover representative success/rejection paths rather than every
protocol state transition; the domain reports list the missing scenarios explicitly.
Deployment discovery establishes graph consistency, not trusted implementation identity.

Review the upstream app discrepancies in [INTEGRATION_NOTES.md](INTEGRATION_NOTES.md),
especially its four stale navigator bytecodes, and establish artifact release ownership,
licensing and public package policy. [FEATURE_COVERAGE.md](FEATURE_COVERAGE.md) distinguishes
complete ABI/table access from convenience gaps and caller-owned services. No public
transactions, deployment, publication or CLI expansion were part of this audit.
