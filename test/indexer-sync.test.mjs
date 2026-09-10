import test from 'node:test';
import assert from 'node:assert/strict';
import { assertIndexerHealthy, waitForIndexedBlock, DaoShipsIndexer } from '../dist/indexer.js';

const NOW = Date.parse('2026-09-09T12:00:00Z');
const state = { chain_id: 15000, last_block_number: '9007199254740993', last_indexed_at: '2026-09-09T11:59:00Z', is_syncing: true, requires_full_reindex: false };
const options = { chainId: 15000 };

test('checkpoint health uses exact blocks and explicit clocks at inclusive lag and age boundaries', () => {
  assert.deepEqual(assertIndexerHealthy(state, { ...options, expectedBlock: 9007199254740998n, maxBlockLag: 5n, nowMs: NOW, maxAgeMs: 60_000 }), {
    indexedBlock: 9007199254740993n, blockLag: 5n, ageMs: 60_000, isSyncing: true,
  });
  assert.equal(assertIndexerHealthy(state, { ...options, expectedBlock: 0n }).blockLag, 0n);
  assert.equal(assertIndexerHealthy({ ...state, last_block_number: 42 }, options).indexedBlock, 42n);
  assert.equal(assertIndexerHealthy({ ...state, last_block_number: 42n }, options).indexedBlock, 42n);
  assert.throws(() => assertIndexerHealthy(state, { ...options, expectedBlock: 9007199254740999n, maxBlockLag: 5n }), error => error.code === 'INDEXER_ERROR' && error.details.reason === 'BEHIND' && error.details.blockLag === '6');
  assert.throws(() => assertIndexerHealthy(state, { ...options, nowMs: NOW, maxAgeMs: 59_999 }), error => error.code === 'INDEXER_ERROR' && error.details.reason === 'STALE');
});

test('checkpoint health refuses wrong chains, reindex flags, unknown state and unsafe numeric coercions', () => {
  assert.throws(() => assertIndexerHealthy(state, { chainId: 1 }), { code: 'CHAIN_MISMATCH' });
  assert.throws(() => assertIndexerHealthy({ ...state, requires_full_reindex: true, reindex_reason: 'deep reorg' }, options), error => error.code === 'INDEXER_ERROR' && error.details.reason === 'REINDEX_REQUIRED' && error.details.reindexReason === 'deep reorg');
  assert.throws(() => assertIndexerHealthy(null, options), error => error.code === 'INDEXER_ERROR' && error.details.reason === 'NOT_INITIALIZED');
  for (const value of [Number.MAX_SAFE_INTEGER + 1, -1, '1.5', '01', null]) assert.throws(() => assertIndexerHealthy({ ...state, last_block_number: value }, options), { code: 'INVALID_RESPONSE' });
  assert.throws(() => assertIndexerHealthy({ ...state, last_indexed_at: 'invalid' }, options), { code: 'INVALID_RESPONSE' });
  assert.throws(() => assertIndexerHealthy({ ...state, last_indexed_at: null }, { ...options, nowMs: NOW, maxAgeMs: 60_000 }), error => error.code === 'INDEXER_ERROR' && error.details.reason === 'STALE');
  for (const patch of [{ chainId: 0 }, { expectedBlock: 1 }, { maxBlockLag: 1n }, { maxAgeMs: 1 }, { nowMs: NaN }, { expectedBlock: -1n }]) assert.throws(() => assertIndexerHealthy(state, { ...options, ...patch }), { code: 'INVALID_ARGUMENT' });
});

test('checkpoint wait polls absent and behind states, returning the exact reached checkpoint', async () => {
  const final = { ...state, last_block_number: '9007199254740995' };
  const sequence = [null, state, final];
  let calls = 0;
  const reached = await waitForIndexedBlock({ async getStateDetails(signal) { assert.equal(signal.aborted, false); return sequence[calls++]; } }, 9007199254740995n, { ...options, pollIntervalMs: 1, timeoutMs: 1000 });
  assert.equal(reached, final); assert.equal(calls, 3);
  // Active indexing does not invalidate a committed checkpoint.
  assert.equal(reached.is_syncing, true);
});

test('checkpoint wait rejects wrong chain and reindex immediately instead of polling unsafe state', async () => {
  for (const [patch, code] of [[{ chain_id: 1 }, 'CHAIN_MISMATCH'], [{ requires_full_reindex: true }, 'INDEXER_ERROR']]) {
    let calls = 0;
    await assert.rejects(waitForIndexedBlock({ async getStateDetails() { calls++; return { ...state, ...patch }; } }, 1n, { ...options, pollIntervalMs: 1 }), { code });
    assert.equal(calls, 1);
  }
});

test('checkpoint wait bounds hung readers and long polling sleeps, and cancellation takes precedence', async () => {
  await assert.rejects(waitForIndexedBlock({ getStateDetails: () => new Promise(() => {}) }, 10n, { ...options, timeoutMs: 5 }), error => error.code === 'TIMEOUT' && error.details.targetBlock === '10' && error.details.lastIndexedBlock === null);
  await assert.rejects(waitForIndexedBlock({ async getStateDetails() { return { ...state, last_block_number: '3' }; } }, 10n, { ...options, timeoutMs: 5, pollIntervalMs: 1000 }), error => error.code === 'TIMEOUT' && error.details.lastIndexedBlock === '3');
  let calls = 0;
  await assert.rejects(waitForIndexedBlock({ async getStateDetails() { calls++; return state; } }, 1n, { ...options, signal: AbortSignal.abort() }), { code: 'ABORTED' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  await assert.rejects(waitForIndexedBlock({ async getStateDetails(signal) { controller.abort(); assert.equal(signal.aborted, true); return state; } }, 1n, { ...options, signal: controller.signal }), { code: 'ABORTED' });
});

test('indexer convenience uses the complete precision-preserving checkpoint projection', async () => {
  const complete = { ...state, id: 1, last_block_hash: null, reindex_reason: null, reindex_flagged_at: null };
  const indexer = new DaoShipsIndexer({ url: 'https://indexer.test', schema: 'testnet', key: 'sb_publishable_test', fetch: async url => {
    assert.equal(url.pathname, '/rest/v1/ds_indexer_state');
    assert.match(url.searchParams.get('select'), /last_block_number::text/);
    return Response.json([complete]);
  } });
  assert.deepEqual(await indexer.waitForIndexedBlock(9007199254740993n, options), complete);
  for (const patch of [{ timeoutMs: 0 }, { pollIntervalMs: -1 }, { timeoutMs: 2 ** 31 }]) await assert.rejects(indexer.waitForIndexedBlock(1n, { ...options, ...patch }), { code: 'INVALID_ARGUMENT' });
});

test('checkpoint waits capture chain, freshness and cancellation requirements before awaiting', async () => {
  let release;
  const response = new Promise(resolve => { release = resolve; });
  const settings = { ...options, nowMs: NOW, maxAgeMs: 60_000, timeoutMs: 1000 };
  const pending = waitForIndexedBlock({ getStateDetails: () => response }, 1n, settings);
  settings.chainId = 1;
  settings.maxAgeMs = 1_000_000;
  release({ ...state, chain_id: 1 });
  await assert.rejects(pending, { code: 'CHAIN_MISMATCH' });

  let finish;
  const staleResponse = new Promise(resolve => { finish = resolve; });
  const fresh = { ...options, nowMs: NOW, maxAgeMs: 1, timeoutMs: 1000 };
  const stale = waitForIndexedBlock({ getStateDetails: () => staleResponse }, 1n, fresh);
  fresh.maxAgeMs = 1_000_000;
  finish(state);
  await assert.rejects(stale, error => error.code === 'INDEXER_ERROR' && error.details.reason === 'STALE');

  const controller = new AbortController();
  const abortOptions = { ...options, signal: controller.signal, timeoutMs: 1000 };
  const cancelled = waitForIndexedBlock({ getStateDetails: () => new Promise(() => {}) }, 1n, abortOptions);
  abortOptions.signal = undefined;
  controller.abort();
  await assert.rejects(cancelled, { code: 'ABORTED' });
});

test('checkpoint wait enforces elapsed deadlines when synchronous readers delay timer delivery', async () => {
  let observedSignal;
  await assert.rejects(waitForIndexedBlock({ getStateDetails(signal) {
    observedSignal = signal;
    const end = performance.now() + 15;
    while (performance.now() < end) {}
    return Promise.resolve(state);
  } }, 1n, { ...options, timeoutMs: 5 }), { code: 'TIMEOUT' });
  assert.equal(observedSignal.aborted, true);
});
