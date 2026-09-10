import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { sendPreparedTransaction, resumeTransaction } from '../dist/index.js';
const A = '0x0011111111111111111111111111111111111111';
const HASH = '0x' + '11'.repeat(32);
const data = new Interface(['function processProposal(uint32,bytes)']).encodeFunctionData('processProposal', [1, '0x']);

test('process gas headroom follows the calldata selector, including full-signature generic calls', async () => {
  const prepared = { from: A, to: A, data, value: 0n, chainId: 15000, operation: 'processProposal(uint32,bytes)',
    checkedAt: { blockNumber: 1, blockHash: HASH } };
  let calls = 0;
  const signer = { provider: { getNetwork: async () => ({ chainId: 15000n }) }, getAddress: async () => A,
    estimateGas: async () => 101n, sendTransaction: async request => {
      calls++; assert.equal(request.gasLimit, 152n); return { hash: HASH };
    } };
  await sendPreparedTransaction(prepared, signer, { refresh: async () => prepared, onSubmitted: () => {} });
  assert.equal(calls, 1);
});

test('unknown broadcast outcome is explicit and a send is never automatically retried', async () => {
  const prepared = { from: A, to: A, data, value: 0n, chainId: 15000, operation: 'processProposal',
    checkedAt: { blockNumber: 1, blockHash: HASH } };
  let calls = 0, persisted = false;
  const signer = { provider: { getNetwork: async () => ({ chainId: 15000n }) }, getAddress: async () => A,
    estimateGas: async () => 1n, sendTransaction: async () => { calls++; throw new Error('connection reset'); } };
  await assert.rejects(sendPreparedTransaction(prepared, signer, { refresh: async () => prepared, onSubmitted: () => { persisted = true; } }), { code: 'BROADCAST_ERROR' });
  assert.equal(calls, 1); assert.equal(persisted, false);
});

test('resume only waits for the persisted hash with bounded confirmation settings', async () => {
  const receipt = { status: 1, logs: [] };
  const result = await resumeTransaction({ async waitForTransaction(hash, confirms, timeout) {
    assert.equal(hash, HASH); assert.equal(confirms, 3); assert.equal(timeout, 1000); return receipt;
  } }, HASH, { confirmations: 3, timeoutMs: 1000 });
  assert.equal(result, receipt);
});
