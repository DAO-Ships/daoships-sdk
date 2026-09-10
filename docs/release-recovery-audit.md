# Initial-release transaction and recovery audit

Reviewed 2026-09-10: `src/transactions.ts`, `src/transaction-recovery.ts`, their public contracts, persistence format, nonce coordination, replacement scanning, and focused regression suites. This is a source and adversarial-test review, not an independent security certification or live Quai acceptance test.

## Findings fixed

| Severity | Finding and reproducible consequence | Resolution |
| --- | --- | --- |
| Medium, integrity | Inspection read `receipt.status` again after awaiting canonical-block RPCs. A provider reusing/mutating its returned receipt object during those reads could change an observed revert into a mined success. | Capture numeric status with the receipt identity before asynchronous block validation. A regression mutates status from zero to one inside `getBlock` and still requires `reverted`. |
| Medium, availability | Recovery bounded its initial/final identity reads but left refresh, gas estimation and the low-level sender's repeated identity reads unbounded. Cancellation after queue acquisition could still permit a later broadcast. | Apply the existing per-operation timeout and abort signal to every read-only preflight stage. Late completion cannot reach signing. Explicitly preserve active signing and persistence exclusion, where an outstanding operation can have effects. Tests cover hanging refresh/estimate/network/account reads, active cancellation and cancellation after signer invocation. |
| Medium, availability | Abandonment could commit between insertion of a prepared intent and insertion of its account reservation. The broadcaster correctly lost its revision check, but cleanup used the same stale revision and stranded the new cursor behind a durable `not_sent` record. | Reconcile durable `not_sent` before releasing an unused reservation. An interleaving test abandons inside the initial CAS acknowledgement and verifies that the next intent can use the unused nonce without a manual repair. |
| Low, stability | Confirmation captured the transaction hash but looked up its wait callback in a later microtask. Mutation of the caller's transaction object could replace the operation being awaited. | Capture and bind the original wait method before scheduling, with a mutation regression. |

The audit also retained undefined-rejection handling in bounded operations: a rejected promise with no rejection value must not accidentally become a successful result.

## Reviewed invariants

- Each logical intent ID is one-shot; no retry, cancellation transaction or fee replacement is automatically signed.
- A durable atomic account CAS, rather than a process-local queue alone, prevents two coordinators from reserving the same account nonce. A stale pending count cannot reduce the recorded nonce floor.
- `broadcasting` precedes signer invocation. Ambiguous broadcast outcomes and lost write acknowledgements preserve quarantine; inspection requires matching chain, sender, nonce and payload before accepting original evidence.
- Explicit abandonment is confined to prepared/not-sent records, and its revision change prevents a concurrent preparation from entering broadcast.
- Receipt observations verify numeric status, hash, sender, destination, canonical block identity and requested confirmation depth. A later inspection clears a stale receipt after an observed reorg.
- Replacement hashes from native wait errors are only candidates until validated by RPC. Cancellation is explicitly a transaction-shape heuristic. A differently encoded successful replacement does not establish success of the original DAO action.
- Serialization bounds calldata and JSON size, preserves bigint value exactly, rejects accessors and unsupported fields, and validates status/evidence consistency. Stored records are detached from caller objects.
- Queue, RPC and replacement-scan limits are finite. Scans report incomplete windows and never infer non-broadcast from absent evidence.

## Remaining release requirements and boundaries

Production consumers must supply and acceptance-test a durable, atomic store shared by every process sending from an account. The included in-memory store is intentionally not durable. Test the selected adapter for process termination before and after commit, lost acknowledgements, stale reads, competing writers, and service restart; unit fault injection cannot certify an application's database configuration.

Run live Quai acceptance with the supported pinned provider/wallet implementation: pending-nonce behavior, signer honoring explicit nonce and chain, real replacement errors, reconnects and receipt finality. The SDK assumes a truthful provider and a signer honoring its transaction request. Independent wallets or workflow executors using another nonce policy can conflict; applications must coordinate all account users.

An indefinitely pending or dropped transaction requires an explicit application/wallet recovery decision. The SDK does not infer absence, decrease a nonce floor based on a missing RPC transaction, or automatically fill nonce gaps. A stuck active signer and an uncertain storage operation are deliberately not unlocked by cancellation; configure backend deadlines and investigate the durable record before any subsequent send.

Native contract creation uses deployment executors rather than the address-targeted recovery sender. DAO business outcome verification remains separate from receipt status: callers must verify expected DAO/navigator events and inner proposal action success. These boundaries do not require a QuaiVault SDK dependency.

## Validation

Focused validation after the fixes: TypeScript build, 26 recovery tests, and 16 transaction-audit tests pass. Seven recovery regressions and one confirmation regression were added. The release coordinator runs the complete coverage, package, source, contract and runtime matrix checks after integrating parallel audit changes.
