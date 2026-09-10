import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { DaoShipsChain, DAO_SHIP_ABI, ProposalState, sendPreparedTransaction, confirmTransaction,
  resumeTransaction, parseSubmitReceipt } from '../dist/index.js';
import { hex, uint } from '../dist/values.js';
const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const H = '0x' + '11'.repeat(32), H2 = '0x' + '22'.repeat(32);
const iface = new Interface(DAO_SHIP_ABI);
function sendFixture() {
  const prepared = { chainId: 9, from: A, to: B, data: '0x', value: 5n, operation: 'contractCall', checkedAt: { blockNumber: 1, blockHash: H } };
  const sent = [], persisted = [];
  const signer = { provider: { getNetwork: async () => ({ chainId: 9n }) }, getAddress: async () => A,
    estimateGas: async () => 100n, sendTransaction: async request => { sent.push(request); return { hash: H }; } };
  const options = { refresh: async () => ({ ...prepared }), onSubmitted: record => { persisted.push(record); } };
  return { prepared, sent, persisted, signer, options };
}
function chainFixture({ reorg = false, switchNetwork = false, onNetwork, onCall } = {}) {
  let networkReads = 0;
  const calls = [];
  const provider = {
    async getNetwork() { onNetwork?.(); networkReads++; return { chainId: switchNetwork && networkReads > 1 ? 10n : 9n }; },
    async getBlock(_shard, tag) { return { hash: reorg && tag !== 'latest' ? H2 : H, woHeader: { number: 1, timestamp: 100 } }; },
    async call(request) {
      calls.push(request); onCall?.();
      if (request.data === '0x') return '0x';
      const parsed = iface.parseTransaction(request);
      if (parsed.name === 'state') return iface.encodeFunctionResult('state', [ProposalState.Voting]);
      if (parsed.name === 'getProposalStatus') return iface.encodeFunctionResult('getProposalStatus', [[false, false, false, false]]);
      return '0x';
    },
  };
  return { chain: new DaoShipsChain(provider, 9), calls };
}
test('audit: snapshots reject reorgs and provider network switches during reads and simulations', async () => {
  for (const [options, code] of [[{ reorg: true }, 'CHAIN_ERROR'], [{ switchNetwork: true }, 'CHAIN_MISMATCH']]) {
    await assert.rejects(chainFixture(options).chain.getProposal(A, 1), { code });
    await assert.rejects(chainFixture(options).chain.prepareCall({ to: B, data: '0x', value: 0n }, A), { code });
  }
});
test('audit: generic preparations capture intended input before any provider await', async () => {
  const call = { to: B, data: '0x', value: 5n };
  const f = chainFixture({ onNetwork() { call.to = A; call.value = 99n; } });
  const result = await f.chain.prepareCall(call, A);
  assert.equal(result.to, B); assert.equal(result.value, 5n);
});
test('audit: batch vote objects and arrays cannot change during preflight', async () => {
  const votes = [{ proposalId: 1, approved: true }];
  const f = chainFixture({ onNetwork() { votes[0].proposalId = 2; votes[0].approved = false; votes.push({ proposalId: 3, approved: false }); } });
  const result = await f.chain.prepareVotes(A, votes, B);
  const decoded = iface.decodeFunctionData('submitVotes', result.data);
  assert.deepEqual([...decoded[0]], [1n]); assert.deepEqual([...decoded[1]], [true]);
});
test('audit: estimateGas cannot modify the transaction subsequently broadcast', async () => {
  const f = sendFixture();
  f.signer.estimateGas = async request => { request.to = A; request.data = '0x1234'; request.value = 999n; return 100n; };
  await sendPreparedTransaction(f.prepared, f.signer, f.options);
  assert.equal(f.sent[0].to, B); assert.equal(f.sent[0].data, '0x'); assert.equal(f.sent[0].value, 5n);
});
test('audit: signer account, network and provider replacement during estimation stop broadcast', async () => {
  for (const kind of ['account', 'network', 'provider']) {
    const f = sendFixture();
    f.signer.estimateGas = async () => {
      if (kind === 'account') f.signer.getAddress = async () => B;
      if (kind === 'network') f.signer.provider.getNetwork = async () => ({ chainId: 10n });
      if (kind === 'provider') f.signer.provider = { getNetwork: async () => ({ chainId: 9n }) };
      return 100n;
    };
    await assert.rejects(sendPreparedTransaction(f.prepared, f.signer, f.options), { code: kind === 'account' ? 'SIGNER_MISMATCH' : 'CHAIN_MISMATCH' });
    assert.equal(f.sent.length, 0);
  }
});
test('audit: persistence callback and gas multiplier are captured before refresh', async () => {
  const f = sendFixture();
  f.options.gasMultiplierPercent = 120n;
  f.options.refresh = async () => { f.options.onSubmitted = () => assert.fail('mutated callback'); f.options.gasMultiplierPercent = 1000n; return f.prepared; };
  await sendPreparedTransaction(f.prepared, f.signer, f.options);
  assert.equal(f.sent[0].gasLimit, 120n); assert.equal(f.persisted.length, 1);
});
test('audit: malformed chain IDs and gas estimates fail before broadcast', async () => {
  for (const chainId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    const f = sendFixture(); f.prepared.chainId = chainId;
    await assert.rejects(sendPreparedTransaction(f.prepared, f.signer, f.options), { code: 'INVALID_ARGUMENT' });
    assert.equal(f.sent.length, 0);
  }
  for (const estimate of [0n, -1n, 1n << 256n, (1n << 256n) - 1n]) {
    const f = sendFixture(); f.signer.estimateGas = async () => estimate;
    await assert.rejects(sendPreparedTransaction(f.prepared, f.signer, f.options));
    assert.equal(f.sent.length, 0);
  }
});
test('audit: missing broadcast hash reports uncertain outcome without retry', async () => {
  const f = sendFixture(); let sends = 0;
  f.signer.sendTransaction = async () => { sends++; return { hash: 'bad' }; };
  await assert.rejects(sendPreparedTransaction(f.prepared, f.signer, f.options), { code: 'BROADCAST_ERROR' });
  assert.equal(sends, 1); assert.equal(f.persisted.length, 0);
});
test('audit: unknown receipt status never implies reversion or success', async () => {
  for (const status of [null, undefined, -1, 2, '1', '0', true]) {
    const receipt = { status, logs: [] };
    await assert.rejects(confirmTransaction({ hash: H, wait: async () => receipt }), { code: 'TX_PENDING' });
    assert.throws(() => parseSubmitReceipt(receipt, A), { code: 'TX_PENDING' });
  }
});
test('audit: confirmations reject receipts for a different transaction', async () => {
  for (const receiptHash of [H2, null, 5, {}]) for (const status of [0, 1]) {
    await assert.rejects(confirmTransaction({ hash: H, wait: async () => ({ hash: receiptHash, status, logs: [] }) }), { code: 'TX_PENDING' });
  }
  await assert.rejects(confirmTransaction({ hash: H, wait: async () => { throw { receipt: { hash: H2, status: 0 } }; } }), { code: 'TX_PENDING' });
});
test('audit: resume timeout is immutable across asynchronous scheduling', async () => {
  const options = { timeoutMs: 1000 };
  const result = resumeTransaction({ async waitForTransaction(_hash, _confirmations, timeout) {
    assert.equal(timeout, 1000); return { status: 1, logs: [] };
  } }, H, options);
  options.timeoutMs = 1;
  await result;
});
test('audit: cancellation in scheduling gap avoids starting the provider wait', async () => {
  const controller = new AbortController(); let waited = false;
  const result = confirmTransaction({ hash: H, wait: async () => { waited = true; return { status: 1, logs: [] }; } }, { signal: controller.signal });
  controller.abort();
  await assert.rejects(result, { code: 'TX_PENDING' }); assert.equal(waited, false);
});
test('audit: byte validation rejects coercible objects and uint widths are bounded', () => {
  assert.throws(() => hex({ toString: () => '0x1234' }), { code: 'INVALID_ARGUMENT' });
  for (const bits of [0, -1, 1.5, NaN, Infinity, 257, 1e9]) assert.throws(() => uint(1n, bits), { code: 'INVALID_ARGUMENT' });
  assert.equal(uint(1n, 1), 1n); assert.equal(uint((1n << 256n) - 1n), (1n << 256n) - 1n);
});
test('audit: hung chain RPC operations time out and response size is bounded before decode', async () => {
  const provider = { getNetwork: async () => ({ chainId: 9n }), getBlock: async () => ({ hash: H, woHeader: { number: 1, timestamp: 100 } }), call: async () => new Promise(() => {}) };
  await assert.rejects(new DaoShipsChain(provider, 9, { timeoutMs: 5 }).getProposal(A, 1), { code: 'TIMEOUT' });
  provider.call = async () => '0x' + '00'.repeat(33);
  await assert.rejects(new DaoShipsChain(provider, 9, { maxResponseBytes: 32 }).getProposal(A, 1), { code: 'INVALID_RESPONSE' });
  provider.getNetwork = async () => new Promise(() => {});
  await assert.rejects(new DaoShipsChain(provider, 9, { timeoutMs: 5 }).getProposal(A, 1), { code: 'TIMEOUT' });
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: Infinity }, { maxResponseBytes: 0 }]) assert.throws(() => new DaoShipsChain(provider, 9, options), { code: 'INVALID_ARGUMENT' });
});

test('audit: persistence failure retains the original broadcast hash despite response mutation', async () => {
  const f = sendFixture(), response = { hash: H };
  f.signer.sendTransaction = async () => response;
  f.options.onSubmitted = async () => { response.hash = H2; throw new Error('disk full'); };
  await assert.rejects(sendPreparedTransaction(f.prepared, f.signer, f.options), error => error.code === 'PERSISTENCE_ERROR' && error.details.hash === H);
});

test('audit: confirmation captures the original bound wait method before asynchronous scheduling', async () => {
  const transaction = { hash: H, async wait() { assert.equal(this, transaction); return { hash: H, status: 1, logs: [] }; } };
  const confirming = confirmTransaction(transaction);
  transaction.wait = async () => { throw Error('mutated callback'); };
  assert.equal((await confirming).status, 1);
});
