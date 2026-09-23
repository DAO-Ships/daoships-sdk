import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Shard, getAddress } from 'quais';
import { readBlock } from '../dist/blocks.js';
import { discoverDeployment } from '../dist/deployments.js';

const hash = '0x' + 'ab'.repeat(32), parentHash = '0x' + 'cd'.repeat(32), tx = '0x' + 'ef'.repeat(32);
// What quais throws from getBlock() for an older mainnet block (totalEntropy null).
const badData = () => Object.assign(new Error('invalid value for value.totalEntropy'), { code: 'BAD_DATA' });
// Trimmed raw quai_getBlockByNumber result for such a block.
const raw = (overrides = {}) => ({ hash, totalEntropy: null, woHeader: { number: '0x8baaac', timestamp: '0x6a5ff543', parentHash }, transactions: [tx], ...overrides });

test('readBlock returns getBlock() unchanged when quais can format the block', async () => {
  const formatted = { hash, woHeader: { number: 9153196 } };
  let sent = 0;
  const provider = { async getBlock() { return formatted; }, async send() { sent++; } };
  assert.equal(await readBlock(provider, Shard.Cyprus1, 9153196), formatted);
  assert.equal(sent, 0);
});

test('readBlock reads the block raw when quais rejects it', async () => {
  const calls = [];
  const provider = {
    async getBlock() { throw badData(); },
    async send(...args) { calls.push({ args, self: this }); return raw(); },
  };
  assert.deepEqual(await readBlock(provider, Shard.Cyprus1, 9153196), {
    hash, woHeader: { number: 9153196, timestamp: 0x6a5ff543, parentHash }, transactions: [tx],
  });
  assert.deepEqual(calls[0].args, ['quai_getBlockByNumber', ['0x8baaac', false], Shard.Cyprus1]);
  assert.equal(calls[0].self, provider, 'send is called on the provider, as JsonRpcProvider requires');
});

test('readBlock passes latest through and returns null for a block the node lacks', async () => {
  const tags = [];
  const provider = { async getBlock() { throw badData(); }, async send(_method, [tag]) { tags.push(tag); return tag === 'latest' ? raw() : null; } };
  assert.equal((await readBlock(provider, Shard.Cyprus1, 'latest')).woHeader.number, 9153196);
  assert.equal(await readBlock(provider, Shard.Cyprus1, 99_999_999), null);
  assert.deepEqual(tags, ['latest', '0x5f5e0ff']);
});

test('readBlock keeps the original error without a send() fallback or for other failures', async () => {
  const failure = badData();
  await assert.rejects(readBlock({ async getBlock() { throw failure; } }, Shard.Cyprus1, 1), error => error === failure);
  const network = Object.assign(new Error('socket hang up'), { code: 'NETWORK_ERROR' });
  let sent = 0;
  await assert.rejects(readBlock({ async getBlock() { throw network; }, async send() { sent++; } }, Shard.Cyprus1, 1), error => error === network);
  assert.equal(sent, 0, 'only a formatting failure falls back');
});

test('readBlock fails closed on a raw block it cannot trust', async () => {
  const cases = {
    'another height': raw(),
    'a short hash': raw({ hash: '0xabcd' }),
    'no woHeader': raw({ woHeader: undefined }),
    'a decimal height': raw({ woHeader: { number: '9153197', timestamp: '0x6a5ff543', parentHash } }),
    'no timestamp': raw({ woHeader: { number: '0x8baaad', parentHash } }),
    'a bad parent hash': raw({ woHeader: { number: '0x8baaad', timestamp: '0x6a5ff543', parentHash: '0x12' } }),
    'full transactions': raw({ woHeader: { number: '0x8baaad', timestamp: '0x6a5ff543' }, transactions: [{ hash: tx }] }),
  };
  for (const [label, response] of Object.entries(cases)) {
    const provider = { async getBlock() { throw badData(); }, async send() { return response; } };
    await assert.rejects(readBlock(provider, Shard.Cyprus1, 9153197), { code: 'INVALID_RESPONSE' }, label);
  }
});

test('deployment discovery completes when its pinned block is one quais cannot format', async () => {
  const contracts = Object.fromEntries(['daoShipAndVaultLauncher', 'daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly', 'daoShipSingleton', 'sharesSingleton', 'lootSingleton', 'vaultSingleton']
    .map((name, i) => [name, getAddress(`0x00${(BigInt(i) + 1n).toString(16).padStart(38, '0')}`)]));
  const views = { [contracts.daoShipAndVaultLauncher]: ['daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly'], [contracts.daoShipLauncher]: ['daoShipSingleton', 'sharesSingleton', 'lootSingleton'], [contracts.quaiVaultFactory]: ['implementation'] };
  const provider = {
    async getNetwork() { return { chainId: 9n }; },
    async getBlock(_shard, tag) { if (tag === 'latest') return { hash, woHeader: { number: 123 } }; throw badData(); },
    async send(_method, [tag]) { assert.equal(tag, '0x7b'); return raw({ woHeader: { number: '0x7b', timestamp: '0x6a5ff543' } }); },
    async call(req) {
      for (const method of views[req.to] ?? []) {
        const iface = new Interface([`function ${method}() view returns (address)`]);
        if (req.data === iface.encodeFunctionData(method)) return iface.encodeFunctionResult(method, [contracts[method === 'implementation' ? 'vaultSingleton' : method]]);
      }
      throw new Error('Unexpected contract call');
    },
    async getCode() { return '0x6000'; },
  };
  const found = await discoverDeployment(provider, { chainId: 9, launcher: contracts.daoShipAndVaultLauncher });
  assert.equal(found.blockNumber, 123);
  assert.equal(found.contracts.vaultSingleton, contracts.vaultSingleton);
});
