import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, getAddress } from 'quais';
import { discoverDeployment, verifyDeployment, minimalProxyImplementation } from '../dist/deployments.js';
const contracts = Object.fromEntries(['daoShipAndVaultLauncher','daoShipLauncher','quaiVaultFactory','multisendCallOnly','daoShipSingleton','sharesSingleton','lootSingleton','vaultSingleton'].map((name, i) => [name, getAddress(`0x00${(BigInt(i) + 1n).toString(16).padStart(38, '0')}`)]));
function fixture(overrides = {}) {
  const seen = [];
  const views = { [contracts.daoShipAndVaultLauncher]: ['daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly'], [contracts.daoShipLauncher]: ['daoShipSingleton', 'sharesSingleton', 'lootSingleton'], [contracts.quaiVaultFactory]: ['implementation'] };
  const provider = {
    async getNetwork() { return { chainId: 9n }; },
    async getBlock(_shard, block) { seen.push(['block', block]); return { hash: '0x' + 'ab'.repeat(32), woHeader: { number: 123 } }; },
    async call(tx) {
      assert.equal(tx.blockTag, 123); assert.equal(tx.from, tx.to);
      for (const method of views[tx.to] ?? []) {
        const iface = new Interface([`function ${method}() view returns (address)`]);
        if (tx.data === iface.encodeFunctionData(method)) return iface.encodeFunctionResult(method, [contracts[method === 'implementation' ? 'vaultSingleton' : method]]);
      }
      throw new Error('Unexpected contract call');
    },
    async getCode(to, block) { seen.push(['code', to, block]); return '0x6000'; },
    ...overrides,
  };
  return { provider, seen };
}
test('deployment discovery walks references and bytecode at a stable block', async () => {
  const { provider, seen } = fixture();
  const result = await discoverDeployment(provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher });
  assert.deepEqual(result, { chainId: 9, blockNumber: 123, blockHash: '0x' + 'ab'.repeat(32), contracts });
  assert.equal(seen.filter(row => row[0] === 'code').length, 8);
  assert.ok(seen.filter(row => row[0] === 'code').every(row => row[2] === 123));
  assert.deepEqual(seen.at(-1), ['block', 123]);
  assert.deepEqual(await verifyDeployment(provider, { chainId: 9, contracts }), result);
});
test('deployment verification rejects wrong chain, missing code, mismatched graph, and reorg', async () => {
  await assert.rejects(discoverDeployment(fixture().provider, { chainId: 15000, launcher: contracts.daoShipAndVaultLauncher }), { code: 'CHAIN_MISMATCH' });
  await assert.rejects(discoverDeployment(fixture({ getCode: async () => '0x' }).provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(verifyDeployment(fixture().provider, { chainId: 9, contracts: { ...contracts, sharesSingleton: contracts.lootSingleton } }), { code: 'CHAIN_MISMATCH' });
  await assert.rejects(discoverDeployment(fixture({ getBlock: async (_s, tag) => ({ hash: tag === 'latest' ? '0x' + 'ab'.repeat(32) : '0x' + 'cd'.repeat(32), woHeader: { number: 123 } }) }).provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher }), { code: 'CHAIN_ERROR' });
  await assert.rejects(discoverDeployment(fixture({ call: async () => { throw new Error('RPC down'); } }).provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher }), { code: 'CHAIN_ERROR' });
});
test('proxy identification accepts exact ERC-1167 runtime, rejecting misleading embedded markers', () => {
  const code = `0x363d3d373d3d3d363d73${contracts.daoShipSingleton.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(minimalProxyImplementation(code), contracts.daoShipSingleton);
  assert.equal(minimalProxyImplementation('0x00' + code.slice(2)), null);
  assert.equal(minimalProxyImplementation(code + '00'), null);
  assert.equal(minimalProxyImplementation('0x'), null);
});

test('deployment discovery captures options and rejects network switches during graph traversal', async () => {
  const options = { chainId: 9, launcher: contracts.daoShipAndVaultLauncher };
  let networks = 0;
  const provider = fixture({ getNetwork: async () => { options.chainId = 10; return { chainId: ++networks === 1 ? 9n : 10n }; } }).provider;
  await assert.rejects(discoverDeployment(provider, options), { code: 'CHAIN_MISMATCH' });
  const expected = { chainId: 9, contracts: { ...contracts, sharesSingleton: contracts.lootSingleton } };
  const mutation = fixture({ getNetwork: async () => { expected.contracts.sharesSingleton = contracts.sharesSingleton; return { chainId: 9n }; } }).provider;
  await assert.rejects(verifyDeployment(mutation, expected), { code: 'CHAIN_MISMATCH' });
});

test('deployment discovery bounds provider waits, response bytes and cancellation before RPC', async () => {
  await assert.rejects(discoverDeployment(fixture({ getNetwork: async () => new Promise(() => {}) }).provider,
    { chainId: 9, launcher: contracts.daoShipAndVaultLauncher, timeoutMs: 2 }), { code: 'TIMEOUT' });
  let calls = 0;
  const controller = new AbortController();
  const options = { chainId: 9, launcher: contracts.daoShipAndVaultLauncher, signal: controller.signal };
  const pending = discoverDeployment(fixture({ getNetwork: async () => { calls++; return { chainId: 9n }; } }).provider, options);
  options.signal = new AbortController().signal;
  controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' });
  assert.equal(calls, 0);
  await assert.rejects(discoverDeployment(fixture({ call: async () => '0x' + '00'.repeat(33) }).provider,
    { chainId: 9, launcher: contracts.daoShipAndVaultLauncher, maxResponseBytes: 32 }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(discoverDeployment(fixture({ getCode: async () => '0x' + '00'.repeat(33) }).provider,
    { chainId: 9, launcher: contracts.daoShipAndVaultLauncher, maxResponseBytes: 32 }), { code: 'INVALID_RESPONSE' });
  for (const invalid of [{ timeoutMs: 0 }, { maxResponseBytes: -1 }]) {
    await assert.rejects(discoverDeployment(fixture().provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher, ...invalid }), { code: 'INVALID_ARGUMENT' });
  }
});

test('deployment discovery rejects a changed block height even when the supplied hash is unchanged', async () => {
  const provider = fixture({ getBlock: async (_shard, tag) => ({ hash: '0x' + 'ab'.repeat(32), woHeader: { number: tag === 'latest' ? 123 : 124 } }) }).provider;
  await assert.rejects(discoverDeployment(provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher }), { code: 'CHAIN_ERROR' });
});

test('deployment discovery rejects malformed mined block identities before following references', async () => {
  for (const block of [{ hash: '0xabc', woHeader: { number: 123 } }, { hash: '0x' + 'ab'.repeat(32) }, { hash: 1, woHeader: { number: 123 } }]) {
    let called = false;
    const provider = fixture({ getBlock: async () => block, call: async () => { called = true; throw Error('Unexpected call'); } }).provider;
    await assert.rejects(discoverDeployment(provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher }), { code: 'INVALID_RESPONSE' });
    assert.equal(called, false);
  }
});
