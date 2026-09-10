# Storage and executor conformance

The SDK exports reusable conformance checks for application-owned recovery stores, deployment stores and deployment executors. Run them against disposable test resources before using an adapter in production. These checks write synthetic records and invoke the supplied executor; executor fixtures must use a fake transport or a disposable local chain, never a funded public-chain signer.

## Consumer-owned stores

```ts
import {
  assertRecoveryStoreConformance,
  assertWorkflowStoreConformance,
} from '@daoships/sdk';

// Each factory opens an independent adapter over the SAME disposable backend.
const recovery = await assertRecoveryStoreConformance(
  async () => new ApplicationRecoveryStore(testDatabase),
  { namespace: crypto.randomUUID(), contenders: 8, timeoutMs: 10_000 },
);
const workflows = await assertWorkflowStoreConformance(
  async () => new ApplicationWorkflowStore(testDatabase),
  { namespace: crypto.randomUUID(), contenders: 8, timeoutMs: 10_000 },
);
console.log(recovery.checks, workflows.checks);
```

`ApplicationRecoveryStore` and `ApplicationWorkflowStore` are your implementations of the SDK interfaces, not classes provided by the SDK. Factories must share the same backing data; returning unrelated empty databases is not a valid test.

The recovery suite checks transaction records and account nonce records. The workflow suite checks deployment checkpoints. Both verify:

- Missing keys return `null`; test keys must be unused.
- CAS insertion/update returns a boolean, stale revisions and duplicate insertion return `false`, and rejected writes leave the previous record intact.
- Reads and committed writes are detached snapshots, with exact bigint preservation for recovery intents. Adapters may reorder JSON object keys.
- Independently opened instances see committed updates and exactly one concurrent contender wins an insertion.
- Malformed revisions/records and immutable identity changes are rejected without mutation. Recovery intent, sender and chain remain immutable; workflow plan identity remains immutable.
- Reopening the adapter preserves acknowledged state.

Recovery records begin at revision zero. Workflow checkpoints begin at revision one, matching `advanceDeploymentWorkflow`; subsequent updates increment by one. The underlying database must perform comparison and durable replacement atomically. Separate read and unconditional write operations do not satisfy CAS. A read followed by an atomic conditional update is appropriate when the database predicate includes the exact expected revision and preserves immutable fields.

Every report includes `checks`, the synthetic `keys` left for inspection, and `durability: 'not-certified'`. Opening another adapter instance does not prove disk persistence or distributed consistency. Run the same checks against the actual production database implementation, then test real process termination, backend failover and acknowledgement loss in its staging environment. A write deadline can expire before a late commit; use disposable isolated data and investigate the backend before cleanup.

The required namespace contains 1–64 letters, digits, dots, underscores or hyphens and starts with a letter or digit. Use a fresh namespace per run. Contender count is bounded to 2–32; per-operation timeout is 1–60,000 milliseconds. The checks do not delete records or reset nonce cursors. Delete the entire disposable backend only after all test workers and pending operations have stopped.

## Application-owned deployment executors

```ts
import { assertDeploymentExecutorConformance } from '@daoships/sdk';

const result = await assertDeploymentExecutorConformance(
  async scenario => createInstrumentedLocalExecutorFixture(scenario),
  { namespace: crypto.randomUUID() },
);
```

`createInstrumentedLocalExecutorFixture` returns an `ExecutorConformanceFixture`: the real adapter under test, a matching plan/step and prepared step, plus an `observe()` function reporting how many times its instrumented transport entered broadcast and confirmation-wait operations. Build a fresh isolated fixture for each scenario. Counters must observe the adapter's real transport boundaries; they are not values the executor may invent.

The success scenario verifies one broadcast, one hash callback, awaited persistence before confirmation, and the matching successful receipt. The failure scenario injects a rejected persistence acknowledgement after broadcast. The executor must propagate the failure, skip confirmation and avoid a second send. A failed acknowledgement is deliberately ambiguous: the adapter cannot assume the hash was not written. The helper also detects missing callbacks, fire-and-forget persistence, invalid/different hashes, premature waits and swallowed persistence failures.

The conformance helper does not authorize a vault proposal as a completed DAO action. The normal workflow runner still independently verifies receipt identity, source events, exact transaction/proposal data and current permissions. Instrumented executor conformance is an ordering check; contract and public-network acceptance remain separate requirements.

## Reference durable backend and process fault tests

The repository's `scripts/conformance/file-store.mjs` is a test-support reference. It exports `openFileRecoveryStore(directory, options?)`, `openFileWorkflowStore(directory, options?)` and `recoverFileStoreLock(directory, exitedPid)`. Recovery and workflow stores require separate controlled directories. Every operation opens/closes its own handles; no `.close()` method is needed.

The reference backend uses an exclusive lock directory with PID/token ownership, validates records, writes a new file, calls file `fsync`, atomically renames it, and calls directory `fsync` before acknowledging. Readers load detached records from the complete committed file. A fault hook exposes `after-lock`, `before-commit` and `after-commit` with `{ key, record }`, so tests can kill a real writer or throw after an actual commit. An uncommitted temporary file cannot replace the last committed snapshot.

This is **not a production database adapter**: it rewrites a bounded 32 MiB file, serializes all writes, assumes one host and a filesystem with the required rename/fsync semantics, and requires explicit dead-worker lock recovery. No database runtime dependency was added. The reference and process fixtures are repository test support; installed consumers use the public conformance functions with their own adapters.

Never reclaim a lock merely because it is old. `recoverFileStoreLock` requires the exact PID of a worker the test/operator observed exiting and refuses a live PID or a different lock owner. Recovery itself must run under an exclusive operator/session lock; two recovery operators must not race. If a crash occurs before complete owner metadata is written, the helper fails closed and an operator must investigate the disposable directory. PID reuse also fails closed. These constraints are intentional and unsuitable as an unattended distributed production lock.

Run the process suite from the SDK checkout:

```sh
npm run test:adapters
```

It starts actual Node worker processes over the reference backend and a durable fake-chain broadcast journal. It exercises six-worker duplicate-intent and nonce races; process termination before commit, after the broadcast marker, after a recorded broadcast, after hash persistence and after account release; a committed write whose acknowledgement is lost; and deployment executor termination with submitting, submitted and verified checkpoints. Restarted SDK calls recover persisted evidence, preserve unresolved quarantine and never repeat an already recorded broadcast. The fake-chain journal survives worker termination, so restarting a JavaScript object cannot erase evidence of duplicate sends.

The suite also demonstrates that no matching network evidence after an uncertain broadcast marker authorizes a retry, and that a live writer's lock is not reclaimed by elapsed time. These are real multi-process filesystem tests with a fake blockchain. They do not establish public Quai behavior, multi-host database durability or safety against machine power loss. The same invariants must be exercised against the selected production store and wallet/provider stack.
