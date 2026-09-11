import test from 'node:test';
import assert from 'node:assert/strict';
import { Shard } from 'quais';
import {
  InMemoryTransactionRecoveryStore, InProcessRecoveryCoordinator, serializeRecoveryRecord, parseRecoveryRecord,
  recoveryAccountKey, recoveryTransactionKey, sendRecoverableTransaction, inspectRecoveryTransaction,
  waitForRecoveryTransaction, abandonPreparedTransaction, scanRecoveryReplacements,
} from '../dist/transaction-recovery.js';
import { sendPreparedTransaction } from '../dist/transactions.js';
const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const C = '0x0033333333333333333333333333333333333333';
const H = '0x' + '11'.repeat(32), R = '0x' + '22'.repeat(32), BLOCK = '0x' + '33'.repeat(32), FORK = '0x' + '44'.repeat(32);
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const transactions = new Map(), receipts = new Map(), calls = [], writes = [];
  const prepared = { chainId: 9, from: A, to: B, data: '0x1234', value: 1n << 180n, operation: 'example', checkedAt: { blockNumber: 3, blockHash: BLOCK } };
  const expected = structuredClone(prepared);
  const provider = {
    getNetwork: async () => ({ chainId: 9n }),
    async getTransactionCount(from, tag) { assert.equal(from, A); assert.ok(['pending', 'latest'].includes(tag)); return 0; },
    getTransaction: async hash => transactions.get(hash) ?? null,
    getTransactionReceipt: async hash => receipts.get(hash) ?? null,
    async getBlock(shard, tag) { assert.equal(shard, Shard.Cyprus1); return { hash: BLOCK, woHeader: { number: tag === 'latest' ? 5 : tag }, transactions: [] }; },
  };
  const signer = { provider, getAddress: async () => A, estimateGas: async () => 100n,
    async sendTransaction(request) {
      const hash = calls.length === 0 ? H : '0x' + (calls.length + 10).toString(16).padStart(64, '0');
      calls.push(structuredClone(request)); transactions.set(hash, { ...request, hash });
      return { hash, wait: async () => null };
    } };
  const baseStore = new InMemoryTransactionRecoveryStore();
  const store = { read: key => baseStore.read(key), async compareAndSwap(key, revision, record) { writes.push(structuredClone(record)); return baseStore.compareAndSwap(key, revision, record); } };
  const options = { id: 'flow/step', store, coordinator: new InProcessRecoveryCoordinator(), refresh: async () => structuredClone(expected) };
  const receipt = (hash = H, status = 1, to = B) => ({ hash, status, from: A, to, blockHash: BLOCK, blockNumber: 3, logs: [] });
  return { prepared, expected, provider, signer, calls, store, baseStore, writes, options, transactions, receipts, receipt };
}
async function stored(f, id = f.options.id) { return f.store.read(recoveryTransactionKey(id)); }
async function cursor(f) { return f.store.read(recoveryAccountKey(9, A)); }
async function sent(f) { return sendRecoverableTransaction(f.prepared, f.signer, f.options); }

test('late recovery preflight results cannot broadcast after the RPC deadline', async () => {
  for (const stage of ['network', 'refresh', 'estimate']) {
    const f = fixture(); f.options.timeoutMs = 5;
    const stall = result => async () => { const until = performance.now() + 20; while (performance.now() < until) {} return result; };
    if (stage === 'network') f.provider.getNetwork = stall({ chainId: 9n });
    if (stage === 'refresh') f.options.refresh = stall(f.expected);
    if (stage === 'estimate') f.signer.estimateGas = stall(100n);
    await assert.rejects(sent(f), { code: 'TIMEOUT' });
    assert.equal(f.calls.length, 0);
    if (stage !== 'network') {
      assert.equal((await stored(f)).status, 'not_sent');
      assert.equal((await cursor(f)).blockedBy, null); assert.equal((await cursor(f)).nextNonce, 0);
    }
  }
});

test('an expired queued recovery operation never starts and does not strand following work', async () => {
  const coordinator = new InProcessRecoveryCoordinator(), gate = deferred();
  const first = coordinator.runExclusive('account', () => gate.promise);
  let starts = 0;
  const expired = coordinator.runExclusive('account', async () => { starts++; }, { waitTimeoutMs: 5 });
  const rejected = assert.rejects(expired, { code: 'RECOVERY_BLOCKED' });
  const next = coordinator.runExclusive('account', async () => 'next');
  const until = performance.now() + 20; while (performance.now() < until) {}
  gate.resolve();
  await first; await rejected; assert.equal(await next, 'next'); assert.equal(starts, 0);
});

test('recovery persists reviewed intent and broadcasting marker before a one-shot nonce-bound send', async () => {
  const f = fixture(); const result = await sent(f);
  assert.equal(result.record.status, 'submitted'); assert.equal(result.record.hash, H);
  assert.equal(result.record.intent.value, 1n << 180n); assert.equal(result.record.intent.nonce, 0);
  assert.deepEqual(f.writes.filter(r => r.kind === 'transaction').map(r => r.status), ['prepared', 'broadcasting', 'submitted']);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].nonce, 0); assert.equal(f.calls[0].chainId, 9n);
  assert.equal((await cursor(f)).blockedBy, null); assert.equal((await cursor(f)).nextNonce, 1);
  result.record.intent.value = 99n;
  assert.equal((await stored(f)).intent.value, 1n << 180n);
});

test('versioned recovery JSON preserves exact values and rejects malformed, inconsistent or accessor records', async () => {
  const f = fixture(); const { record } = await sent(f);
  const json = serializeRecoveryRecord(record);
  assert.equal(JSON.parse(json).intent.value, (1n << 180n).toString());
  assert.deepEqual(parseRecoveryRecord(json), record);
  await assert.rejects(f.baseStore.compareAndSwap(recoveryTransactionKey(record.id), record.revision, { ...record, revision: record.revision + 1, intent: { ...record.intent, value: 3n } }), { code: 'INVALID_ARGUMENT' });
  const invalid = [ { ...record, version: 2 }, { ...record, revision: -1 }, { ...record, surprise: true },
    { ...record, status: 'prepared' }, { ...record, status: 'mined' }, { ...record, intent: { ...record.intent, nonce: 1.1 } },
    { ...record, intent: { ...record.intent, value: -1n } }, { ...record, intent: { ...record.intent, value: 1n << 256n } },
    { ...record, status: 'reverted', receipt: { hash: H, blockHash: BLOCK, blockNumber: 3, confirmations: 1, status: 1 } },
    { ...record, status: 'cancelled', replacement: { hash: R, reason: 'repriced' }, receipt: { hash: R, blockHash: BLOCK, blockNumber: 3, confirmations: 1, status: 1 } } ];
  for (const value of invalid) assert.throws(() => serializeRecoveryRecord(value), { code: 'INVALID_ARGUMENT' });
  for (const value of ['{', 'x'.repeat(2_200_001), json.replace((1n << 180n).toString(), '1e30'), json.replace('"version":1', '"version":3')]) assert.throws(() => parseRecoveryRecord(value), { code: 'INVALID_ARGUMENT' });
  let accessed = false;
  const accessor = { ...record }; Object.defineProperty(accessor, 'intent', { enumerable: true, get() { accessed = true; return record.intent; } });
  assert.throws(() => serializeRecoveryRecord(accessor), { code: 'INVALID_ARGUMENT' }); assert.equal(accessed, false);
});

test('concurrent sends use distinct durable nonces despite a stale pending RPC count', async () => {
  const f = fixture();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, id: 'step-' + i })));
  assert.deepEqual(results.map(value => value.record.intent.nonce), [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(f.calls.map(tx => tx.nonce), [0, 1, 2, 3, 4, 5, 6, 7]);
  await assert.rejects(sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, id: 'step-0' }), { code: 'RECOVERY_CONFLICT' });
  assert.equal(f.calls.length, 8);
});

test('atomic account CAS prevents competing coordinator instances from broadcasting one nonce twice', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled([sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, id: 'one', coordinator: new InProcessRecoveryCoordinator() }),
    sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, id: 'two', coordinator: new InProcessRecoveryCoordinator() })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].nonce, 0);
});

test('failed refresh or estimation never broadcasts and safely releases an unused nonce', async () => {
  for (const failure of ['refresh', 'estimate']) {
    const f = fixture();
    if (failure === 'refresh') f.options.refresh = async () => ({ ...f.expected, value: 1n });
    else f.signer.estimateGas = async () => { throw Error('revert'); };
    await assert.rejects(sent(f), { code: failure === 'refresh' ? 'PLAN_CHANGED' : 'CHAIN_ERROR' });
    assert.equal(f.calls.length, 0); assert.equal((await stored(f)).status, 'not_sent');
    assert.equal((await cursor(f)).nextNonce, 0); assert.equal((await cursor(f)).blockedBy, null);
    f.options.refresh = async () => f.expected; f.signer.estimateGas = async () => 100n;
    const next = await sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, id: 'retry-reviewed' });
    assert.equal(next.record.intent.nonce, 0);
  }
});

test('durable broadcasting marker cannot open a wallet identity race before actual send', async () => {
  for (const mode of ['provider', 'account', 'network', 'during-rpc', 'timeout', 'reservation']) {
    const f = fixture(); f.options.timeoutMs = 10;
    f.store.compareAndSwap = async (key, revision, record) => {
      const committed = await f.baseStore.compareAndSwap(key, revision, record);
      if (committed && mode === 'reservation' && record.kind === 'nonce' && record.blockedBy) f.signer.provider = { ...f.provider };
      if (committed && record.kind === 'transaction' && record.status === 'broadcasting') {
        if (mode === 'provider') f.signer.provider = { ...f.provider };
        if (mode === 'account') f.signer.getAddress = async () => C;
        if (mode === 'network') f.provider.getNetwork = async () => ({ chainId: 10n });
        if (mode === 'during-rpc') f.provider.getNetwork = async () => { f.signer.provider = { ...f.provider }; return { chainId: 9n }; };
        if (mode === 'timeout') f.provider.getNetwork = () => new Promise(() => {});
      }
      return committed;
    };
    await assert.rejects(sent(f), { code: mode === 'account' ? 'SIGNER_MISMATCH' : mode === 'timeout' ? 'TIMEOUT' : 'CHAIN_MISMATCH' });
    assert.equal(f.calls.length, 0, mode);
    assert.equal((await stored(f)).status, 'not_sent', mode);
    assert.equal((await cursor(f)).blockedBy, null, mode);
    assert.equal((await cursor(f)).nextNonce, 0, mode);
  }
});

test('ambiguous broadcast quarantines the account and survives adapter/coordinator restart', async () => {
  const f = fixture(), originalSend = f.signer.sendTransaction;
  f.signer.sendTransaction = async request => { await originalSend(request); throw Error('connection reset after broadcast'); };
  await assert.rejects(sent(f), error => error.code === 'BROADCAST_ERROR' && error.details.id === f.options.id && error.details.nonce === 0);
  assert.equal((await stored(f)).status, 'unknown'); assert.equal((await cursor(f)).blockedBy, f.options.id);
  const restarted = new InMemoryTransactionRecoveryStore();
  for (const key of [recoveryTransactionKey(f.options.id), recoveryAccountKey(9, A)]) {
    const record = parseRecoveryRecord(serializeRecoveryRecord(await f.store.read(key)));
    // Rebuild this test adapter at its original revision via a serialized backing-store wrapper.
    const revisions = record.revision;
    for (let revision = 0; revision <= revisions; revision++) await restarted.compareAndSwap(key, revision === 0 ? null : revision - 1, { ...record, revision });
  }
  const restartedOptions = { ...f.options, id: 'next', store: restarted, coordinator: new InProcessRecoveryCoordinator() };
  await assert.rejects(sendRecoverableTransaction(f.prepared, f.signer, restartedOptions), { code: 'RECOVERY_BLOCKED' });
  const noEvidence = await inspectRecoveryTransaction(restarted, f.provider, f.options.id);
  assert.equal(noEvidence.outcome, 'unknown'); assert.match(noEvidence.reason, /does not prove/);
  assert.equal((await restarted.read(recoveryAccountKey(9, A))).blockedBy, f.options.id);
  const recovered = await inspectRecoveryTransaction(restarted, f.provider, f.options.id, { transactionHash: H });
  assert.equal(recovered.outcome, 'pending'); assert.equal(recovered.record.hash, H);
  assert.equal((await restarted.read(recoveryAccountKey(9, A))).blockedBy, null);
  assert.equal(f.calls.length, 1);
});

test('lost persistence acknowledgements preserve hash and quarantine even if the durable write committed', async () => {
  for (const commit of [false, true]) {
    const f = fixture(); let failed = false;
    f.store.compareAndSwap = async (key, revision, record) => {
      if (!failed && record.kind === 'transaction' && record.status === 'submitted') {
        failed = true; if (commit) await f.baseStore.compareAndSwap(key, revision, record); throw Error('database disconnected');
      }
      return f.baseStore.compareAndSwap(key, revision, record);
    };
    await assert.rejects(sent(f), error => error.code === 'PERSISTENCE_ERROR' && error.details.hash === H);
    assert.equal(f.calls.length, 1); assert.equal((await cursor(f)).blockedBy, f.options.id);
    const recovered = await inspectRecoveryTransaction(f.store, f.provider, f.options.id, { transactionHash: H });
    assert.equal(recovered.outcome, 'pending'); assert.equal((await cursor(f)).blockedBy, null);
  }
});

test('explicit abandon uses CAS to stop an in-flight preparation but cannot abandon broadcasting', async () => {
  const f = fixture(), gate = deferred(), started = deferred();
  f.options.refresh = async () => { started.resolve(); await gate.promise; return f.expected; };
  const sending = sent(f); await started.promise;
  const observation = await inspectRecoveryTransaction(f.store, f.provider, f.options.id);
  assert.equal(observation.record.status, 'prepared');
  assert.equal((await abandonPreparedTransaction(f.store, f.options.id)).status, 'not_sent');
  gate.resolve(); await assert.rejects(sending, { code: 'RECOVERY_CONFLICT' }); assert.equal(f.calls.length, 0);
  const blocked = fixture(); blocked.signer.sendTransaction = async () => { throw Error('unknown'); };
  await assert.rejects(sent(blocked));
  await assert.rejects(abandonPreparedTransaction(blocked.store, blocked.options.id), { code: 'RECOVERY_BLOCKED' });
});

test('confirmation observations validate depth, sender/nonce/chain, receipt identity and later reorgs', async () => {
  const f = fixture(); await sent(f); f.receipts.set(H, f.receipt());
  const mined = await inspectRecoveryTransaction(f.store, f.provider, f.options.id, { confirmations: 3 });
  assert.equal(mined.outcome, 'mined'); assert.equal(mined.record.receipt.confirmations, 3);
  const insufficient = await inspectRecoveryTransaction(f.store, f.provider, f.options.id, { confirmations: 4 });
  assert.equal(insufficient.outcome, 'pending'); assert.equal(insufficient.record.receipt, undefined);
  const oldGetBlock = f.provider.getBlock;
  f.provider.getBlock = async (shard, tag) => ({ ...await oldGetBlock(shard, tag), hash: tag === 'latest' ? BLOCK : FORK });
  assert.equal((await inspectRecoveryTransaction(f.store, f.provider, f.options.id)).outcome, 'pending');
  f.provider.getBlock = oldGetBlock;
  for (const patch of [{ from: C }, { nonce: 8 }, { chainId: 10n }]) {
    const original = f.transactions.get(H); f.transactions.set(H, { ...original, ...patch });
    await assert.rejects(inspectRecoveryTransaction(f.store, f.provider, f.options.id), { code: 'CHAIN_MISMATCH' });
    f.transactions.set(H, original);
  }
  f.receipts.set(H, { ...f.receipt(), to: C });
  await assert.rejects(inspectRecoveryTransaction(f.store, f.provider, f.options.id), { code: 'CHAIN_MISMATCH' });
  f.receipts.set(H, f.receipt(H, 0));
  assert.equal((await inspectRecoveryTransaction(f.store, f.provider, f.options.id)).outcome, 'reverted');
});

test('missing or unknown receipts never authorize resubmission or imply reversion', async () => {
  const f = fixture(); await sent(f);
  for (const receipt of [null, { ...f.receipt(), status: null }, { ...f.receipt(), status: '0' }]) {
    f.receipts.set(H, receipt);
    assert.equal((await inspectRecoveryTransaction(f.store, f.provider, f.options.id)).outcome, 'pending');
  }
  f.transactions.clear(); f.receipts.set(H, f.receipt());
  assert.equal((await inspectRecoveryTransaction(f.store, f.provider, f.options.id)).outcome, 'unknown');
  await assert.rejects(sent(f), { code: 'RECOVERY_CONFLICT' }); assert.equal(f.calls.length, 1);
});

test('replacement and cancellation outcomes come from verified nonce-bound mined transactions', async () => {
  for (const kind of ['repriced', 'different_payload', 'cancellation_shape']) {
    const f = fixture(); await sent(f);
    const replacement = { ...f.transactions.get(H), hash: R, ...(kind === 'different_payload' ? { to: C } : kind === 'cancellation_shape' ? { to: A, value: 0n, data: '0x' } : {}) };
    f.transactions.set(R, replacement);
    const pending = await inspectRecoveryTransaction(f.store, f.provider, f.options.id, { replacementHash: R });
    assert.equal(pending.outcome, 'pending'); assert.equal(pending.record.replacement.reason, kind);
    f.receipts.set(R, f.receipt(R, 1, replacement.to));
    const final = await inspectRecoveryTransaction(f.store, f.provider, f.options.id);
    assert.equal(final.outcome, kind === 'cancellation_shape' ? 'cancelled' : 'replaced');
    assert.equal(final.record.receipt.hash, R);
    assert.equal(final.record.replacement.reason, kind);
  }
});

test('repricing an intended empty self-transfer is not mislabeled as cancellation', async () => {
  const f = fixture(); f.prepared.to = A; f.prepared.value = 0n; f.prepared.data = '0x'; f.options.refresh = async () => f.prepared;
  await sent(f); f.transactions.set(R, { ...f.transactions.get(H), hash: R }); f.receipts.set(R, f.receipt(R, 1, A));
  const result = await inspectRecoveryTransaction(f.store, f.provider, f.options.id, { replacementHash: R });
  assert.equal(result.outcome, 'replaced'); assert.equal(result.record.replacement.reason, 'repriced');
});

test('native wait replacement errors are persisted only after provider evidence verification', async () => {
  const f = fixture(); await sent(f);
  f.transactions.set(R, { ...f.transactions.get(H), hash: R, to: C }); f.receipts.set(R, f.receipt(R, 1, C));
  const result = await waitForRecoveryTransaction(f.store, f.provider, f.options.id, { hash: H, wait: async () => { throw { code: 'TRANSACTION_REPLACED', cancelled: true, replacement: { hash: R } }; } });
  assert.equal(result.outcome, 'replaced'); assert.equal(result.record.replacement.reason, 'different_payload');
  f.transactions.set(R, { ...f.transactions.get(R), nonce: 2 });
  await assert.rejects(waitForRecoveryTransaction(f.store, f.provider, f.options.id, { hash: H, wait: async () => { throw { code: 'TRANSACTION_REPLACED', replacement: { hash: R } }; } }), { code: 'CHAIN_MISMATCH' });
});

test('recovery captures mutable input/options and refuses invalid explicit nonces before refresh', async () => {
  const f = fixture(); f.provider.getNetwork = async () => { f.prepared.value = 999n; f.options.id = 'changed'; return { chainId: 9n }; };
  const originalId = f.options.id; const result = await sent(f);
  assert.equal(result.record.id, originalId); assert.equal(result.record.intent.value, 1n << 180n);
  for (const nonce of [-1, 1.1, Number.MAX_SAFE_INTEGER, NaN]) {
    let refreshed = false;
    await assert.rejects(sendPreparedTransaction(f.expected, f.signer, { nonce, refresh: async () => { refreshed = true; return f.expected; }, onSubmitted() {} }), { code: 'INVALID_ARGUMENT' });
    assert.equal(refreshed, false);
  }
});

test('bounded coordinator cancels queued work, rejects capacity overflow and retains active exclusion', async () => {
  const coordinator = new InProcessRecoveryCoordinator(1, 1), gate = deferred(), began = deferred();
  const first = coordinator.runExclusive('account', async () => { began.resolve(); await gate.promise; return 1; }); await began.promise;
  let ran = false;
  const queued = coordinator.runExclusive('account', async () => { ran = true; }, { waitTimeoutMs: 5 });
  await assert.rejects(coordinator.runExclusive('account', async () => 3), { code: 'RECOVERY_BLOCKED' });
  await assert.rejects(coordinator.runExclusive('other-account', async () => 3), { code: 'RECOVERY_BLOCKED' });
  await assert.rejects(queued, { code: 'RECOVERY_BLOCKED' }); assert.equal(ran, false);
  gate.resolve(); assert.equal(await first, 1);
});

test('bounded replacement scanning survives restart and makes incomplete/no-match observations explicit', async () => {
  const f = fixture(); const { record } = await sent(f);
  f.transactions.set(R, { ...f.transactions.get(H), hash: R, to: C });
  const blocks = new Map([[3, { hash: BLOCK, woHeader: { number: 3 }, transactions: [H, R] }]]);
  f.provider.getBlock = async (_shard, number) => blocks.get(number) ?? null;
  let scan = await scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 3, toBlock: 3, originalHash: H });
  assert.equal(scan.complete, true); assert.deepEqual(scan.candidates.map(c => c.hash), [R]); assert.equal(scan.candidates[0].samePayload, false);
  assert.equal((await inspectRecoveryTransaction(f.store, f.provider, f.options.id, { replacementHash: R })).outcome, 'pending', 'A discovered candidate without a receipt must remain pending');
  scan = await scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 3, toBlock: 4, originalHash: H });
  assert.equal(scan.complete, false); assert.equal(scan.scannedBlocks, 1);
  scan = await scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 3, toBlock: 3, originalHash: H, maxTransactions: 1 });
  assert.equal(scan.complete, false); assert.deepEqual(scan.candidates, []);
  f.transactions.delete(R);
  scan = await scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 3, toBlock: 3, originalHash: H });
  assert.equal(scan.complete, false);
  blocks.get(3).transactions = [H];
  scan = await scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 3, toBlock: 3, originalHash: H });
  assert.equal(scan.complete, true); assert.deepEqual(scan.candidates, []);
  await assert.rejects(scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 0, toBlock: 200 }), { code: 'INVALID_ARGUMENT' });
});

test('replacement scan discards candidates from blocks changed by a reorg', async () => {
  const f = fixture(); const { record } = await sent(f); let reads = 0;
  f.transactions.set(R, { ...f.transactions.get(H), hash: R, to: C });
  f.provider.getBlock = async () => ({ hash: ++reads === 1 ? BLOCK : FORK, woHeader: { number: 3 }, transactions: [R] });
  const result = await scanRecoveryReplacements(f.provider, record.intent, { fromBlock: 3, toBlock: 3 });
  assert.equal(result.complete, false); assert.deepEqual(result.candidates, []);
});

test('recovery RPC waits are bounded and network changes fail closed', async () => {
  const f = fixture(); await sent(f);
  f.provider.getTransaction = async () => new Promise(() => {});
  await assert.rejects(inspectRecoveryTransaction(f.store, f.provider, f.options.id, { timeoutMs: 5 }), { code: 'TIMEOUT' });
  let reads = 0; f.provider.getTransaction = async key => f.transactions.get(key);
  f.provider.getNetwork = async () => ({ chainId: ++reads === 1 ? 9n : 10n });
  await assert.rejects(inspectRecoveryTransaction(f.store, f.provider, f.options.id), { code: 'CHAIN_MISMATCH' });
  assert.equal((await stored(f)).status, 'submitted');
});

test('receipt status is captured before asynchronous canonical-block validation', async () => {
  const f = fixture(); await sent(f);
  const receipt = f.receipt(H, 0); f.receipts.set(H, receipt);
  const originalGetBlock = f.provider.getBlock;
  f.provider.getBlock = async (...args) => { receipt.status = 1; return originalGetBlock(...args); };
  const observation = await inspectRecoveryTransaction(f.store, f.provider, f.options.id);
  assert.equal(observation.outcome, 'reverted');
  assert.equal(observation.record.receipt.status, 0);
});

test('recovery preflight timeouts release unused reservations and late reads never broadcast', async () => {
  for (const stage of ['refresh', 'estimate', 'network', 'account']) {
    const f = fixture(), late = deferred(); f.options.timeoutMs = 5;
    if (stage === 'refresh') f.options.refresh = () => late.promise;
    if (stage === 'estimate') f.signer.estimateGas = () => late.promise;
    if (stage === 'network') f.options.refresh = async () => { f.provider.getNetwork = () => late.promise; return f.expected; };
    if (stage === 'account') f.options.refresh = async () => { f.signer.getAddress = () => late.promise; return f.expected; };
    await assert.rejects(sent(f), { code: 'TIMEOUT' });
    assert.equal((await stored(f)).status, 'not_sent', stage);
    assert.equal((await cursor(f)).blockedBy, null, stage);
    assert.equal((await cursor(f)).nextNonce, 0, stage);
    late.resolve(stage === 'refresh' ? f.expected : stage === 'estimate' ? 100n : stage === 'account' ? A : { chainId: 9n });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0, stage);
  }
});

test('cancelling active preparation or its durable marker prevents any later broadcast', async () => {
  for (const stage of ['refresh', 'estimate', 'marker']) {
    const f = fixture(), controller = new AbortController(), late = deferred(), started = deferred();
    f.options.signal = controller.signal;
    if (stage === 'refresh') f.options.refresh = async () => { started.resolve(); return late.promise; };
    if (stage === 'estimate') f.signer.estimateGas = async () => { started.resolve(); return late.promise; };
    if (stage === 'marker') f.store.compareAndSwap = async (key, revision, record) => {
      const result = await f.baseStore.compareAndSwap(key, revision, record);
      if (record.status === 'broadcasting') { controller.abort(); started.resolve(); }
      return result;
    };
    const sending = sent(f); await started.promise; controller.abort();
    await assert.rejects(sending, { code: 'ABORTED' });
    late.resolve(stage === 'refresh' ? f.expected : 100n);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.calls.length, 0, stage);
    assert.equal((await stored(f)).status, 'not_sent', stage);
    assert.equal((await cursor(f)).blockedBy, null, stage);
  }
});

test('cancellation after signer invocation retains exclusion and the eventual durable hash', async () => {
  const f = fixture(), controller = new AbortController(), started = deferred(), late = deferred();
  const originalSend = f.signer.sendTransaction; f.options.signal = controller.signal;
  f.signer.sendTransaction = async request => { started.resolve(); await late.promise; return originalSend(request); };
  const sending = sent(f); await started.promise; controller.abort();
  assert.equal((await cursor(f)).blockedBy, f.options.id);
  assert.equal((await stored(f)).status, 'broadcasting');
  await assert.rejects(sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, signal: undefined, id: 'another', waitTimeoutMs: 5 }), { code: 'RECOVERY_BLOCKED' });
  late.resolve();
  const result = await sending;
  assert.equal(result.record.hash, H); assert.equal(result.record.status, 'submitted');
  assert.equal((await cursor(f)).blockedBy, null); assert.equal(f.calls.length, 1);
});

test('recovery cancellation during initial reads never creates durable intent or invokes later work', async () => {
  const f = fixture(), controller = new AbortController(); f.options.signal = controller.signal;
  f.provider.getNetwork = async () => { controller.abort(); return { chainId: 9n }; };
  await assert.rejects(sent(f), { code: 'ABORTED' });
  assert.equal(await stored(f), null); assert.equal(await cursor(f), null); assert.equal(f.calls.length, 0);
});

test('an undefined RPC rejection is still a failure and does not proceed to broadcast', async () => {
  const f = fixture(); f.options.refresh = () => Promise.reject(undefined);
  await assert.rejects(sent(f), { code: 'CHAIN_ERROR' });
  assert.equal((await stored(f)).status, 'not_sent'); assert.equal(f.calls.length, 0);
});

test('abandonment between intent insertion and account reservation does not strand the nonce cursor', async () => {
  const f = fixture(); let abandoned = false;
  f.store.compareAndSwap = async (key, revision, record) => {
    const committed = await f.baseStore.compareAndSwap(key, revision, record);
    if (committed && !abandoned && record.kind === 'transaction' && record.status === 'prepared') {
      abandoned = true;
      await abandonPreparedTransaction(f.store, record.id);
      assert.equal(await cursor(f), null);
    }
    return committed;
  };
  await assert.rejects(sent(f), { code: 'RECOVERY_CONFLICT' });
  assert.equal(f.calls.length, 0); assert.equal((await stored(f)).status, 'not_sent');
  assert.equal((await cursor(f)).blockedBy, null); assert.equal((await cursor(f)).nextNonce, 0);
  const next = await sendRecoverableTransaction(f.prepared, f.signer, { ...f.options, id: 'next' });
  assert.equal(next.record.intent.nonce, 0); assert.equal(f.calls.length, 1);
});
