# Durable DAO transaction recovery

Recovery adds transaction intent records and durable nonce reservations around the existing refreshed, simulated SDK send path. It never automatically resubmits, bumps fees, cancels, or replaces a transaction. The caller continues to own its signer, storage backend, authorization and business outcome checks.

## Send and persist

```ts
const { record, transaction } = await sendRecoverableTransaction(prepared, signer, {
  id: 'dao-launch-2026/profile-post', // Stable, unique logical step ID; reuse for inspection only.
  store: durableStore,
  refresh: () => chain.prepareCall(profileCall, account),
});
const observation = await waitForRecoveryTransaction(durableStore, provider, record.id, transaction, {
  confirmations: 3,
  timeoutMs: 90_000,
});
```

`sendRecoverableTransaction` persists the reviewed chain/sender/destination/calldata/value/operation and the selected nonce. It reserves that account in the store, reuses `sendPreparedTransaction`'s refresh/account/network/gas validation, writes `broadcasting` before calling the signer, rechecks the captured wallet provider/network/account after that durable write, and writes the returned hash before releasing the account reservation. A preflight failure records `not_sent` and releases the unused nonce when that cleanup can be persisted. Ambiguous broadcasts and failures before durable hash persistence leave the account quarantined by the intent ID. If only the account-release acknowledgement is lost after the hash was saved, inspection can reconcile that release safely. The error includes the ID, chain, sender, nonce and returned hash when available.

`timeoutMs` bounds each preflight read, refresh and gas estimate (30 seconds by default). `signal` cancels queue waiting and active preflight until the actual signer invocation. A late read or refresh completion cannot subsequently broadcast. Once the signer has been called, cancellation does not stop waiting for its returned hash or release its reservation: signing may already have an external effect. A stuck signer must be investigated through its wallet/provider and the durable recovery record; a timeout is never proof that it did not broadcast. The low-level `sendPreparedTransaction` leaves preflight deadlines to its caller; use the recovery wrapper for coordinated, bounded preparations.

Never generate a new intent ID simply to bypass a failed send. An existing ID cannot be sent again through this API. Recover it and decide what happened first. Caller-controlled IDs must be unique within the shared store, including across different DAOs and workflow runs.

## Storage adapter contract

`TransactionRecoveryStore` supplies:

- `read(key)`: load a complete record or `null`.
- `compareAndSwap(key, expectedRevision, next)`: atomically test the current revision and durably replace the complete record. `null` inserts only when absent; initial revision is zero; each update increments it exactly once. Return a boolean, with `false` meaning a concurrent change. Revisions must never reset. Record kind/ID, transaction intent, and account chain/sender identities are immutable after insertion.

Use one shared durable adapter for every SDK process using an account. A database transaction with revision predicates, or an equivalently atomic durable key/value operation, can implement CAS. A `read` followed by an unconditional `write` cannot. A write exception may mean the write committed but its acknowledgement was lost; the SDK therefore preserves uncertainty. Configure backend deadlines in the adapter—storage and active signing calls are not cancelled or unlocked merely because a timeout elapses.

`serializeRecoveryRecord` and `parseRecoveryRecord` implement version-1 bounded JSON. Transaction `value` uses canonical decimal text and restores as bigint; chain IDs, nonces, block heights and revisions must be safe integers. Unknown fields/versions, accessors, unsafe numbers and inconsistent status/receipt combinations are rejected. Parsed records are not authenticated: the persistence backend is a trusted dependency.

The reference `InMemoryTransactionRecoveryStore` provides atomic, detached copies within one process and enforces immutable intent, but is **not durable across process restarts**. Production applications supply their own durable adapter; the SDK does not choose a database or write secrets to disk.

Use the public adapter conformance helpers to test your implementation's CAS, identity, snapshot and executor-ordering guarantees. [Storage and executor conformance](ADAPTER_CONFORMANCE.md) also describes the repository's durable reference backend and real multi-process crash tests. Passing the semantic checks does not certify a production database's durability.

Records are keyed by `recoveryTransactionKey(id)` and `recoveryAccountKey(chainId, sender)`. The latter stores the next nonce floor and `blockedBy` intent. Persist both record kinds and retain their revisions. Do not delete or reset the account cursor while transactions remain unresolved.

## Coordination and concurrency

`InProcessRecoveryCoordinator` is a bounded FIFO queue per account, with defaults of 100 queued jobs per account and 1,000 active account scopes. Queue waits default to 30 seconds and can be cancelled. Active work retains exclusion until it actually completes. It is not a distributed lock. Applications can inject another `RecoveryCoordinator` through `coordinator`.

Even when separate coordinator instances race, the shared store's atomic account reservation admits only one broadcaster; a competitor gets a conflict or blocked error instead of sending the same nonce. The persisted nonce floor also protects against stale pending-count RPC results. Account cursors remain reserved after a crash until evidence resolves them. Coordinating an unrelated wallet, another application, or another storage backend is outside this mechanism; all account users must share the same nonce policy.

The SDK asks the Quai provider for `getTransactionCount(sender, 'pending')` with the explicit address, then supplies the reserved nonce in the transaction request. Nonces are bounded safe integers. The existing low-level sender now accepts optional `SendOptions.nonce` for other caller-owned coordinators.

## Inspect after a restart

```ts
const observation = await inspectRecoveryTransaction(durableStore, provider, intentId, {
  // Optional hash recovered from an error, wallet history, or another durable journal:
  transactionHash: recoveredHash,
  confirmations: 3,
});
```

Inspection validates chain ID, sender, account nonce, hash and transaction contents. It re-reads receipts, verifies block hash/height against the canonical shard, and checks the requested depth. Persisted receipt observations can revert to pending/unknown after an observed reorg. A receipt with missing/unknown status does not imply reversion. A missing transaction is not proof that no transaction was broadcast.

The result exposes an `outcome`, updated record, and reason:

| Outcome | Meaning |
| --- | --- |
| `not_sent` | The record is still prepared or the SDK established that its broadcast call did not start. A prepared record must be explicitly abandoned before starting a different send. |
| `pending` | Validated original/replacement transaction evidence exists, but no canonical receipt at the requested depth. A pending replacement does not establish that the original lost. |
| `mined` / `reverted` | The original transaction has a canonical numeric-status receipt. `mined` does not prove a proposal's inner action succeeded. |
| `replaced` | Another validated transaction consumed the same sender nonce. Check replacement reason and its receipt status; the replacement itself may have reverted. |
| `cancelled` | A different successful transaction consumed the nonce with the zero-value empty self-transfer shape. This is a cancellation heuristic, not proof of the user's intention. Repricing an originally intended empty self-transfer remains `replaced`/`repriced`. |
| `unknown` | Evidence is insufficient. Even an unchanged account nonce does not prove absence from a wallet, another RPC or the mempool. No resubmission is authorized. |

`record.status === 'submitted'` is the persisted pending-original state. Replacement evidence records `repriced`, `different_payload`, or `cancellation_shape`, independently from receipt status. Records retain the latest candidate, not a complete mempool replacement history.

To release an intent abandoned before signing, use `abandonPreparedTransaction(store, id)`. Its CAS prevents a concurrent preparation from subsequently entering broadcast. It refuses broadcasting/unknown/submitted intents. There is no time-based automatic release of an ambiguous nonce reservation.

If abandonment wins before the account reservation is inserted, the sender reconciles the durable `not_sent` record and releases that later reservation. A persistence outage during this cleanup still leaves the cursor conservatively blocked; inspection of the `not_sent` intent can retry release when the store is available.

## Replacement evidence without a retained transaction object

`waitForRecoveryTransaction` accepts the native quais transaction response and captures its `TRANSACTION_REPLACED` error's replacement hash. It ignores an unverified `cancelled` flag and validates the candidate through RPC before persisting an outcome. Timeouts remain observations rather than permission to retry.

After restart, pass a known candidate as `replacementHash` to inspection, or search a caller-selected block window:

```ts
const scan = await scanRecoveryReplacements(provider, record.intent, {
  fromBlock: 123_000,
  toBlock: 123_100,
  originalHash: record.hash,
  maxBlocks: 128,
  maxTransactions: 1000,
});
for (const candidate of scan.candidates) {
  const observation = await inspectRecoveryTransaction(durableStore, provider, record.id, {
    replacementHash: candidate.hash,
    confirmations: 3,
  });
}
```

The scanner uses explicit shard block reads and transaction hashes/objects, matching sender, chain and nonce. It rechecks scanned block hashes and discards candidates from observed reorgs. Missing blocks/transactions or transaction-budget exhaustion set `complete: false`. A complete empty result means only that this specific window produced no candidate; it says nothing about other blocks or pending transactions. Defaults cap a scan at 128 blocks and 1,000 transactions; configured maxima are 10,000 blocks and 100,000 transactions. There is no unbounded history scan or mempool assumption.

## DAO business outcomes and release limits

Recovery stores compact receipt evidence, not full logs. Fetch the selected receipt when validating the expected DAO/navigator events. Continue using `assertActionSucceeded` for intended proposal execution: an outer successful receipt can contain `action_failed`. A verified replacement may have a different payload and must not automatically satisfy the original workflow step.

All network evidence assumes a truthful provider and a signer that honors the explicitly supplied chain, sender, nonce, destination, value and calldata. A later reorg remains possible. No SDK can atomically lock an external wallet or infer a missing hash from a consumed nonce. Native contract creation remains outside the address-targeted prepared-send helper and is handled through deployment executors.

Validation includes fault injection before/after persistence acknowledgement, restart restoration, stale pending counts, competing coordinators, duplicate intent IDs, prepared-abandon races, wallet identity changes during the durable pre-broadcast write, failed preflights, ambiguous broadcasts, replacement/cancellation evidence, receipt depth/reorgs, malformed JSON and bounded scan/queue/RPC behavior. These are offline tests; production adapter crash consistency and real Quai wallet/provider behavior still require acceptance testing.
