import test from 'node:test';
import assert from 'node:assert/strict';
import { VoidSigner } from 'quais';
import { createSmokeSigner } from '../scripts/orchard/smoke.mjs';

const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
function fixture({ chainId = 15000n, balance = 1_000_000n, transaction = {} } = {}) {
  const records = new Map(), sent = [];
  const provider = { async getNetwork() { return { chainId }; }, async getBalance() { return balance; } };
  const evidence = { async get(key) { return records.get(key) ?? null; }, async put(key, value) { records.set(key, value); } };
  const wallet = { address: A, async getAddress() { return A; }, async estimateGas() { return 21000n; },
    async populateQuaiTransaction(request) { return { from: A, to: A, chainId: 15000n, gasLimit: 21000n, gasPrice: 2n, minerTip: 1n, value: 0n, data: '0x', nonce: 1, ...request, ...transaction }; },
    async sendTransaction(request) { assert.ok(records.get('smoke-send-attempt')); sent.push(request); return { hash: '0x' + '11'.repeat(32) }; },
  };
  const config = { maxGasLimit: 30000n, maxFeePerGas: 10n };
  return { records, sent, evidence, wallet, provider, config, signer: createSmokeSigner(wallet, provider, config, evidence) };
}

test('smoke records its attempt before broadcasting and a reopened signer cannot resend', async () => {
  const f = fixture();
  await f.signer.sendTransaction({});
  assert.equal(f.sent.length, 1);
  const reopened = createSmokeSigner(f.wallet, f.provider, f.config, f.evidence);
  await assert.rejects(reopened.sendTransaction({}), { code: 'RECOVERY_BLOCKED' });
  assert.equal(f.sent.length, 1);
});

test('smoke uses the pinned quais signer transaction population API', async () => {
  const f = fixture();
  const wallet = new VoidSigner(A, f.provider);
  wallet.sendTransaction = f.wallet.sendTransaction;
  const signer = createSmokeSigner(wallet, f.provider, f.config, f.evidence);
  await signer.sendTransaction({ from: A, to: A, chainId: 15000n, nonce: 1, gasLimit: 21000n, gasPrice: 2n, value: 0n, data: '0x' });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].chainId, 15000n);
});

test('smoke blocks wrong chains, contract calls, transfers, excessive fees and insufficient balance before any send', async () => {
  for (const patch of [
    { chainId: 9n }, { transaction: { chainId: 9n } }, { transaction: { from: B } },
    { transaction: { to: B } }, { transaction: { value: 1n } }, { transaction: { data: '0x1234' } },
    { transaction: { gasLimit: 30001n } }, { transaction: { gasLimit: 0n } },
    { transaction: { gasPrice: 10n, minerTip: 1n } }, { transaction: { gasPrice: 0n, minerTip: 0n } },
    { balance: 62999n },
  ]) {
    const f = fixture(patch);
    await assert.rejects(f.signer.sendTransaction({}));
    assert.equal(f.sent.length, 0);
    assert.equal(f.records.size, 0);
  }
});

test('smoke never sends if recording the attempt fails, and preserves an ambiguous attempt', async () => {
  const f = fixture();
  f.evidence.put = async () => { throw Error('Disk full'); };
  await assert.rejects(f.signer.sendTransaction({}), /Disk full/);
  assert.equal(f.sent.length, 0);
  const g = fixture();
  g.wallet.sendTransaction = async () => { throw Error('RPC acknowledgement lost'); };
  await assert.rejects(g.signer.sendTransaction({}), /acknowledgement lost/);
  await assert.rejects(g.signer.sendTransaction({}), { code: 'RECOVERY_BLOCKED' });
});
