import test from 'node:test';
import assert from 'node:assert/strict';
import { connectDaoShipsSupabase, DAOSHIPS_SUPABASE, DAOSHIPS_INDEXER_NETWORKS, DaoShipsIndexer, DaoShipsData } from '../dist/index.js';

const KEY = 'sb_publishable_fixture';
const state = (chainId = 15000, overrides = {}) => ({ id: 1, chain_id: chainId,
  last_block_number: '9007199254740993', last_block_hash: `0x${'11'.repeat(32)}`,
  last_indexed_at: new Date().toISOString(), is_syncing: false, requires_full_reindex: false,
  reindex_reason: null, reindex_flagged_at: null, ...overrides,
});
const fetchState = value => async () => Response.json(value === null ? [] : [value]);

test('hosted connection requires explicit network and verifies both public schema mappings', async () => {
  for (const [network, { chainId, schema }] of Object.entries(DAOSHIPS_INDEXER_NETWORKS)) {
    let requests = 0;
    const connection = await connectDaoShipsSupabase({ network, fetch: async (url, options) => {
      requests++;
      assert.equal(url.origin, DAOSHIPS_SUPABASE.url);
      assert.equal(url.pathname, '/rest/v1/ds_indexer_state');
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.apikey, DAOSHIPS_SUPABASE.publishableKey);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.headers['Accept-Profile'], schema);
      return Response.json([state(chainId)]);
    } });
    assert.equal(requests, 1);
    assert.equal(connection.chainId, chainId);
    assert.equal(connection.schema, schema);
    assert.equal(connection.health.indexedBlock, 9007199254740993n);
    assert.ok(connection.indexer instanceof DaoShipsIndexer);
    assert.ok(connection.data instanceof DaoShipsData);
    for (const value of [connection, connection.checkpoint, connection.health, DAOSHIPS_SUPABASE,
      DAOSHIPS_INDEXER_NETWORKS, DAOSHIPS_INDEXER_NETWORKS[network]]) assert.ok(Object.isFrozen(value));
  }
  for (const network of [undefined, 'dev', 'constructor', '__proto__', 'TESTNET', ['testnet'], new String('testnet')]) {
    await assert.rejects(connectDaoShipsSupabase({ network, fetch() { throw Error('Must not request'); } }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(connectDaoShipsSupabase(null), { code: 'INVALID_ARGUMENT' });
});

test('publishable-only connection rejects privileged/legacy keys and unsafe project URLs before requests', async () => {
  const forbidden = () => { throw Error('Must not request'); };
  for (const publishableKey of ['', 'sb_secret_fixture', 'eyJlegacy', ' sb_publishable_x', 'sb_publishable_x\n', 'sb_publishable_', 'sb_publishable_' + 'a'.repeat(513), 1]) {
    await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', publishableKey, fetch: forbidden }), { code: 'INVALID_ARGUMENT' });
  }
  for (const url of ['bad', 'http://project.test', 'https://user:pass@project.test', 'https://project.test/rest/v1', 'https://project.test?x=1', 'https://project.test#x']) {
    await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', url, publishableKey: KEY, fetch: forbidden }), { code: 'INVALID_ARGUMENT' });
  }
  await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', url: 'https://custom.test', fetch: forbidden }), { code: 'INVALID_ARGUMENT' });
  const custom = await connectDaoShipsSupabase({ network: 'testnet', url: 'https://custom.test/', publishableKey: KEY, schema: 'dev', fetch: async (url, request) => {
    assert.equal(url.origin, 'https://custom.test');
    assert.equal(request.headers.apikey, KEY);
    assert.equal(request.headers['Accept-Profile'], 'dev');
    return Response.json([state()]);
  } });
  assert.equal(custom.schema, 'dev');
  assert.equal(custom.chainId, 15000);
});

test('connection fails on unavailable, wrong-chain, reindex-required and stale checkpoints', async () => {
  for (const [value, health, code] of [
    [null, {}, 'INDEXER_ERROR'],
    [state(9), {}, 'CHAIN_MISMATCH'],
    [state(15000, { requires_full_reindex: true }), {}, 'INDEXER_ERROR'],
    [state(15000, { last_indexed_at: '2020-01-01T00:00:00Z' }), {}, 'INDEXER_ERROR'],
    [state(15000, { last_indexed_at: '2020-01-01T00:00:00Z' }), { maxAgeMs: 1000 }, 'INDEXER_ERROR'],
    [state(), { expectedBlock: 9007199254740994n }, 'INDEXER_ERROR'],
    [state(), { maxBlockLag: 1n }, 'INVALID_ARGUMENT'],
  ]) await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', health, fetch: fetchState(value) }), { code });
  await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', fetch: async () => new Response(null, { status: 401 }) }), { code: 'INDEXER_ERROR' });
  await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', signal: AbortSignal.abort(), fetch() { throw Error('Must not request'); } }), { code: 'ABORTED' });
  await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', timeoutMs: 5, fetch: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', maxResponseBytes: 10, fetch: fetchState(state()) }), { code: 'INVALID_RESPONSE' });
});

test('connection captures caller network, schema, key and health requirements across startup awaits', async () => {
  let release;
  const options = { network: 'testnet', publishableKey: KEY, schema: 'testnet', health: { expectedBlock: 9007199254740994n },
    fetch: () => new Promise(resolve => { release = resolve; }),
  };
  const pending = connectDaoShipsSupabase(options);
  options.network = 'mainnet'; options.publishableKey = 'sb_secret_bad'; options.schema = 'mainnet';
  options.health.expectedBlock = 1n;
  release(Response.json([state()]));
  await assert.rejects(pending, { code: 'INDEXER_ERROR' });
  const connection = await connectDaoShipsSupabase({ network: 'testnet', publishableKey: KEY,
    health: { expectedBlock: 9007199254740994n, maxBlockLag: 1n }, fetch: fetchState(state()),
  });
  assert.equal(connection.health.blockLag, 1n);
});

test('hosted connector rejects an invalid record-ordering policy before requesting data', async () => {
  await assert.rejects(connectDaoShipsSupabase({ network: 'testnet', recordOrdering: 'true',
    fetch() { throw Error('Invalid configuration must not request data.'); },
  }), { code: 'INVALID_ARGUMENT' });
});
