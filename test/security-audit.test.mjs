import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { parseNavigatorDeploymentReceipt } from '../dist/navigators.js';
import { DaoShipsChain } from '../dist/chain.js';
import { DaoShipsIndexer } from '../dist/indexer.js';
import { fetchIpfsJson } from '../dist/ipfs.js';
import { confirmTransaction } from '../dist/transactions.js';
import { normalizeQuaiTransaction } from '../dist/provider.js';

const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const HASH = '0x' + '11'.repeat(32);
const CID = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const iface = new Interface(CONTRACT_ABIS.OnboarderNavigator);
const deploymentLog = () => ({ address: A, ...iface.encodeEventLog('NavigatorDeployed', [B, B, 'OnboarderNavigator', 'Name', 'Description']) });

test('navigator deployment receipts preserve unknown outcomes and tolerate malformed neighboring logs', () => {
  for (const status of [null, undefined, '1', 2]) {
    assert.throws(() => parseNavigatorDeploymentReceipt({ status, logs: [deploymentLog()] }, A), { code: 'TX_PENDING' });
  }
  assert.throws(() => parseNavigatorDeploymentReceipt({ status: 0, logs: [] }, A), { code: 'TX_REVERTED' });
  assert.equal(parseNavigatorDeploymentReceipt({ status: 1, logs: [null, {}, { address: A }, deploymentLog()] }, A).name, 'Name');
});

test('navigator deployment events enforce shared receipt bounds and reject deferred ABI errors', () => {
  const receipt = { status: 1, logs: [deploymentLog()] };
  assert.throws(() => parseNavigatorDeploymentReceipt({ ...receipt, logs: Array(10_001).fill(null) }, A), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseNavigatorDeploymentReceipt(receipt, A, {}, { maxDataBytes: 1 }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => parseNavigatorDeploymentReceipt(receipt, A, {}, { maxLogs: 0 }), { code: 'INVALID_ARGUMENT' });
  const malformed = { ...deploymentLog(), data: deploymentLog().data.replace(Buffer.from('Name').toString('hex'), 'ff616d65') };
  assert.throws(() => parseNavigatorDeploymentReceipt({ ...receipt, logs: [malformed] }, A), { code: 'MISSING_EVENT' });
  assert.equal(parseNavigatorDeploymentReceipt({ ...receipt, logs: [malformed, deploymentLog()] }, A).name, 'Name');
});

test('generic chain simulations require bounded hex results and preserve the exact sender and payload', async () => {
  for (const result of [undefined, null, {}, '0x0', '0xgg', '0x' + '00'.repeat(33), '0x']) {
    const calls = [];
    const chain = new DaoShipsChain({ getNetwork: async () => ({ chainId: 9n }),
      getBlock: async () => ({ hash: HASH, woHeader: { number: 1, timestamp: 1000 } }),
      call: async request => { calls.push(request); return result; },
    }, 9, { maxResponseBytes: 32 });
    const prepare = chain.prepareCall({ to: A, data: '0x1234', value: 7n }, B);
    if (result === '0x') assert.equal((await prepare).from, B);
    else await assert.rejects(prepare, { code: 'INVALID_RESPONSE' });
    assert.deepEqual(calls, [{ to: A, from: B, data: '0x1234', value: 7n, blockTag: 1 }]);
  }
});

// A transport may reuse its scratch buffer after each consumed chunk.
function fragmentedResponse(text) {
  const input = new TextEncoder().encode(text), scratch = new Uint8Array(1);
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset === input.length) { controller.close(); return; }
    scratch[0] = input[offset++]; controller.enqueue(scratch);
  } }, { highWaterMark: 0 }));
}

test('IPFS and indexer stream readers copy reused chunks and grow within the payload limit', async () => {
  const value = { name: 'é' + 'abc'.repeat(3000) }, json = JSON.stringify(value);
  const maxBytes = Buffer.byteLength(json);
  assert.deepEqual((await fetchIpfsJson({ resource: CID, maxBytes, fetch: async () => fragmentedResponse(json) })).value, value);
  await assert.rejects(fetchIpfsJson({ resource: CID, maxBytes: maxBytes - 1, fetch: async () => fragmentedResponse(json) }), { code: 'INVALID_RESPONSE' });
  const rows = JSON.stringify([{ id: A, name: 'abc', avatar: B, shares_address: A, loot_address: B, total_shares: '1', total_loot: '2' }]);
  const indexer = new DaoShipsIndexer({ url: 'https://example.invalid', key: 'public', schema: 'testnet',
    maxResponseBytes: Buffer.byteLength(rows), fetch: async () => fragmentedResponse(rows) });
  assert.deepEqual((await indexer.listDaos()).items, JSON.parse(rows));
});

test('custom fetch cannot accidentally mutate headers used by later indexer requests', async () => {
  const headers = [];
  const indexer = new DaoShipsIndexer({ url: 'https://example.invalid', key: 'public', schema: 'testnet', fetch: async (_url, request) => {
    headers.push({ ...request.headers }); request.headers['Accept-Profile'] = 'mutated'; request.headers.apikey = 'mutated';
    return Response.json([]);
  } });
  await indexer.listDaos(); await indexer.listDaos();
  assert.deepEqual(headers[1], headers[0]);
});

test('immediately available empty stream chunks cannot starve cancellation or deadlines', async () => {
  for (const mode of ['abort', 'timeout']) {
    const controller = new AbortController(); let pulls = 0, cancelled = false;
    const timer = mode === 'abort' ? setTimeout(() => controller.abort(), 0) : undefined;
    try {
      await assert.rejects(fetchIpfsJson({ resource: CID, signal: controller.signal, timeoutMs: mode === 'timeout' ? 5 : 30_000,
        fetch: async () => new Response(new ReadableStream({ pull(stream) {
          if (++pulls < 100_000) stream.enqueue(new Uint8Array(0));
          else { stream.enqueue(new TextEncoder().encode('{}')); stream.close(); }
        }, cancel() { cancelled = true; } }, { highWaterMark: 0 })),
      }), { code: mode === 'abort' ? 'ABORTED' : 'TIMEOUT' });
      assert.ok(pulls < 100_000); assert.equal(cancelled, true);
    } finally { clearTimeout(timer); }
  }
});

test('confirmation deadlines survive event loop stalls and retain the submitted hash', async () => {
  for (const status of [1, 0]) {
    await assert.rejects(confirmTransaction({ hash: HASH, wait: async () => {
      const until = performance.now() + 20; while (performance.now() < until) { /* Stall timer delivery. */ }
      return { hash: HASH, status, logs: [] };
    } }, { timeoutMs: 5 }), error => error.code === 'TX_PENDING' && error.details.hash === HASH);
  }
});

test('RPC nonce normalization accepts the safe integer boundary and rejects oversized quantities', () => {
  for (const nonce of ['9007199254740991', '0x1fffffffffffff', Number.MAX_SAFE_INTEGER]) {
    assert.equal(normalizeQuaiTransaction({ nonce }).nonce, '9007199254740991');
  }
  for (const nonce of ['9'.repeat(100_000), '0x' + 'f'.repeat(100_000)]) {
    assert.throws(() => normalizeQuaiTransaction({ nonce }), { code: 'INVALID_RESPONSE' });
  }
});
