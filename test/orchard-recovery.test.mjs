import test from 'node:test';
import assert from 'node:assert/strict';
import { DaoShipsChain, InMemoryTransactionRecoveryStore, recoveryTransactionKey } from '../dist/index.js';
import { runOrchardRecoveryScenarios } from '../scripts/orchard/recovery-scenarios.mjs';

const A = '0x0011111111111111111111111111111111111111';
const H = '0x' + '11'.repeat(32), BLOCK = '0x' + '22'.repeat(32);
const ID = 'acceptance/recovery/rpc-ack-loss';
function fixture() {
  const records = new Map(), transactions = new Map(), store = new InMemoryTransactionRecoveryStore();
  const state = { sends: 0, mined: true, disconnect: false, failJournal: false };
  const receipt = { hash: H, from: A, to: A, status: 1, blockNumber: 10, blockHash: BLOCK, logs: [] };
  const provider = { getNetwork: async () => ({ chainId: 15000n }), getTransactionCount: async () => 0,
    getBlock: async (_shard, tag) => ({ hash: BLOCK, woHeader: { number: tag === 'latest' ? 12 : tag, timestamp: 100 } }),
    call: async () => '0x', getTransaction: async hash => transactions.get(hash) ?? null,
    getTransactionReceipt: async hash => state.mined && transactions.has(hash) ? receipt : null,
    waitForTransaction: async () => state.mined ? receipt : null };
  const signer = { provider, getAddress: async () => A, estimateGas: async () => 100n,
    async sendTransaction(request) { state.sends++; transactions.set(H, { ...request, hash: H }); if (state.disconnect) throw Error('Actual simulated disconnect'); return { hash: H }; } };
  const evidence = { async get(key) { return structuredClone(records.get(key) ?? null); }, async put(key, value) {
    if (state.failJournal && key === 'recovery/rpc-ack-loss') throw Error('Simulated evidence outage');
    records.set(key, structuredClone(value));
  } };
  return { state, store, records, provider, options: { chain: new DaoShipsChain(provider, 15000), provider, signer, store, evidence, confirmations: 2, timeoutMs: 20 } };
}
test('Orchard recovery helper injects acknowledgement loss once and resumes solely from persisted evidence', async () => {
  const f = fixture();
  const first = await runOrchardRecoveryScenarios(f.options);
  assert.equal(first.acknowledgementLoss.passed, true); assert.equal(first.acknowledgementLoss.resumed, false);
  assert.equal(first.unsigned['stale-refresh'].actualSignerInvocations, 0);
  assert.equal(first.unsigned['rejected-signing'].observedStatus, 'unknown');
  assert.equal(f.state.sends, 1);
  const resumed = await runOrchardRecoveryScenarios({ ...f.options });
  assert.equal(resumed.acknowledgementLoss.resumed, true); assert.equal(f.state.sends, 1);
  assert.equal((await f.store.read(recoveryTransactionKey(ID))).status, 'mined');
});
test('Orchard recovery helper preserves pending and unjournaled broadcast uncertainty without resends', async () => {
  for (const mode of ['pending', 'disconnect', 'journal']) {
    const f = fixture(); f.state.mined = mode !== 'pending'; f.state.disconnect = mode === 'disconnect'; f.state.failJournal = mode === 'journal';
    await assert.rejects(runOrchardRecoveryScenarios(f.options), { code: mode === 'pending' ? 'TX_PENDING' : 'BROADCAST_ERROR' });
    assert.equal(f.state.sends, 1);
    if (mode === 'pending') { f.state.mined = true; assert.equal((await runOrchardRecoveryScenarios(f.options)).acknowledgementLoss.resumed, true); }
    else await assert.rejects(runOrchardRecoveryScenarios(f.options), { code: 'TX_PENDING' });
    assert.equal(f.state.sends, 1);
  }
});
test('Orchard recovery helper refuses another network and mismatching persisted hash evidence', async () => {
  const f = fixture(); f.provider.getNetwork = async () => ({ chainId: 9n });
  await assert.rejects(runOrchardRecoveryScenarios(f.options), { code: 'CHAIN_MISMATCH' }); assert.equal(f.state.sends, 0);
  f.provider.getNetwork = async () => ({ chainId: 15000n });
  await runOrchardRecoveryScenarios(f.options);
  f.records.get('recovery/rpc-ack-loss').hash = BLOCK;
  await assert.rejects(runOrchardRecoveryScenarios(f.options), { code: 'TX_PENDING' }); assert.equal(f.state.sends, 1);
});
