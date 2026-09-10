import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { assertRecoveryStoreConformance, assertWorkflowStoreConformance, assertDeploymentExecutorConformance } from '../dist/adapter-conformance.js';
import { InMemoryTransactionRecoveryStore } from '../dist/transaction-recovery.js';
import { openFileRecoveryStore, openFileWorkflowStore } from '../scripts/conformance/file-store.mjs';

const H = '0x' + '11'.repeat(32);
function executorFixture(mode = 'valid') {
  let broadcasts = 0, waits = 0;
  const plan = { id: H, steps: [{ id: 'create', kind: 'creation' }] };
  return { plan, stepId: 'create', prepared: { checkedAt: { blockNumber: 1, blockHash: H }, calls: [], alreadySatisfied: false },
    observe: async () => ({ broadcasts, waits }),
    executor: { async execute(_plan, _step, context) {
      broadcasts++;
      if (mode === 'wait-first') waits++;
      if (mode === 'missing-hash') return { hash: H, status: 1, logs: [] };
      if (mode === 'unawaited') { void context.onSubmitted(H); waits++; return { hash: H, status: 1, logs: [] }; }
      try { await context.onSubmitted(mode === 'invalid-hash' ? 'wrong' : H); }
      catch (cause) { if (mode !== 'swallow-failure') throw cause; }
      if (mode === 'duplicate') { broadcasts++; await context.onSubmitted(H); }
      waits++;
      return { hash: mode === 'wrong-receipt' ? '0x' + '22'.repeat(32) : H, status: 1, blockNumber: 1, logs: [] };
    } } };
}
test('consumer recovery conformance validates transaction and nonce stores without claiming durability', async () => {
  const backing = new InMemoryTransactionRecoveryStore();
  const options = { namespace: 'memory', contenders: 4 };
  const result = await assertRecoveryStoreConformance(async () => { options.timeoutMs = 1; return backing; }, options);
  assert.equal(result.adapter, 'recovery-store'); assert.equal(result.keys.length, 4);
  assert.ok(result.checks.includes('transaction:single-winner-cas')); assert.ok(result.checks.includes('nonce:single-winner-cas'));
  assert.equal(result.durability, 'not-certified'); assert.equal(Object.isFrozen(result.checks), true);
  await assert.rejects(assertRecoveryStoreConformance(async () => backing, { namespace: 'memory' }), error => error.code === 'INVALID_RESPONSE' && error.details.check === 'fresh-namespace');
});
test('reference file recovery and workflow stores pass reusable conformance with independent instances', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'daoships-conformance-unit-'));
  try {
    const recovery = await assertRecoveryStoreConformance(() => openFileRecoveryStore(join(directory, 'recovery')), { namespace: 'disk', contenders: 3 });
    const workflow = await assertWorkflowStoreConformance(() => openFileWorkflowStore(join(directory, 'workflow')), { namespace: 'disk', contenders: 3 });
    assert.equal(recovery.keys.length, 4); assert.equal(workflow.keys.length, 2);
    assert.ok(workflow.checks.includes('reopened-state'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('conformance detects shared read snapshots, stale-write acknowledgements and false atomicity', async () => {
  for (const mode of ['shared-read', 'false-stale', 'false-race', 'accept-invalid']) {
    const base = new InMemoryTransactionRecoveryStore(); let snapshot;
    const store = {
      async read(key) {
        if (mode === 'shared-read' && snapshot) return snapshot;
        return base.read(key);
      },
      async compareAndSwap(key, revision, next) {
        if (mode === 'false-race' && key.endsWith('/race')) { await base.compareAndSwap(key, revision, next); return true; }
        if (mode === 'accept-invalid' && next.version === 2) return true;
        const committed = await base.compareAndSwap(key, revision, next);
        if (mode === 'shared-read' && committed) snapshot = await base.read(key);
        return mode === 'false-stale' ? true : committed;
      },
    };
    await assert.rejects(assertRecoveryStoreConformance(async () => store, { namespace: mode, contenders: 3 }), { code: 'INVALID_RESPONSE' });
  }
});
test('conformance validates bounds and times out hung opens without certifying the adapter', async () => {
  for (const patch of [{ namespace: '' }, { namespace: '../data' }, { timeoutMs: 0 }, { contenders: 1 }, { contenders: 33 }]) {
    await assert.rejects(assertRecoveryStoreConformance(async () => new InMemoryTransactionRecoveryStore(), { namespace: 'invalid', ...patch }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(assertRecoveryStoreConformance(() => new Promise(() => {}), { namespace: 'hung', timeoutMs: 5 }), { code: 'TIMEOUT' });
});
test('executor conformance verifies hash persistence before waits and propagation of a lost acknowledgement', async () => {
  const result = await assertDeploymentExecutorConformance(async () => executorFixture(), { namespace: 'executor' });
  assert.deepEqual(result.checks, ['persist-before-confirmation', 'failed-acknowledgement-stops-executor']);
  assert.equal(result.durability, 'not-certified');
  for (const mode of ['wait-first', 'missing-hash', 'unawaited', 'invalid-hash', 'swallow-failure', 'duplicate', 'wrong-receipt']) {
    await assert.rejects(assertDeploymentExecutorConformance(async () => executorFixture(mode), { namespace: mode }), { code: 'INVALID_RESPONSE' });
  }
});
test('executor conformance refuses missing steps and hung executors', async () => {
  await assert.rejects(assertDeploymentExecutorConformance(async () => ({ ...executorFixture(), stepId: 'missing' }), { namespace: 'missing' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(assertDeploymentExecutorConformance(async () => ({ ...executorFixture(), executor: { execute: () => new Promise(() => {}) } }), { namespace: 'hung', timeoutMs: 5 }), { code: 'TIMEOUT' });
});
