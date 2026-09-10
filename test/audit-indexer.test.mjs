import test from 'node:test';
import assert from 'node:assert/strict';
import { DaoShipsIndexer, indexerShapes, assertIndexerHealthy, waitForIndexedBlock } from '../dist/indexer.js';

const DAO = '0x0011111111111111111111111111111111111111';
const NAV = '0x0022222222222222222222222222222222222222';
const USER = '0x0033333333333333333333333333333333333333';
const client = (fetch, options = {}) => new DaoShipsIndexer({ url: 'https://indexer.test', key: 'sb_publishable_test', schema: 'testnet', fetch, ...options });
const token = { id: 'token', dao_id: DAO, token_address: NAV, enabled: true, created_at: '2026-09-09T00:00:00Z', tx_hash: '0x123' };
const record = content_json => ({ id: 'record', dao_id: DAO, created_at: '2026-09-09T00:00:00Z', user_address: USER, tx_hash: '0x123', tag: 'POST', content_type: 'json', content: '{}', content_json, trust_level: null, block_number: '123' });
const NOW = Date.parse('2026-09-09T00:00:00Z');
const state = { chain_id: 15000, last_block_number: '0', last_indexed_at: new Date(NOW).toISOString(), is_syncing: true, requires_full_reindex: false };

test('audit: immutable table and column allowlists resist JavaScript mutation', () => {
  assert.equal(Object.isFrozen(indexerShapes), true);
  for (const shape of Object.values(indexerShapes)) assert.equal(Object.isFrozen(shape), true);
  assert.throws(() => { indexerShapes.records.content_json = 'string'; }, TypeError);
  assert.throws(() => { indexerShapes.processed_logs = { id: 'string' }; }, TypeError);
  const sdk = client(async () => { throw new Error('must not fetch'); });
  for (const filters of [JSON.parse('{"__proto__":"x"}'), { constructor: 'x' }, { select: '*' }, { content_json: '{}' }]) {
    assert.throws(() => sdk.list('records', { filters }), { code: 'INVALID_ARGUMENT' });
  }
});

test('audit: streamed body budget bounds declared and chunked responses and cancels streams', async () => {
  for (const headers of [{ 'content-length': '9999' }, {}]) {
    let cancelled = false;
    const stream = new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(64)); }, cancel() { cancelled = true; } });
    await assert.rejects(client(async () => new Response(stream, { headers }), { maxResponseBytes: 32 }).list('records'), { code: 'INVALID_RESPONSE' });
    assert.equal(cancelled, true);
  }
  const body = JSON.stringify([token]);
  assert.equal((await client(async () => new Response(body), { maxResponseBytes: Buffer.byteLength(body) }).list('guild_tokens')).items[0].id, 'token');
  await assert.rejects(client(async () => new Response(body), { maxResponseBytes: Buffer.byteLength(body) - 1 }).list('guild_tokens'), { code: 'INVALID_RESPONSE' });
  for (const maxResponseBytes of [0, -1, 1.5, NaN, Infinity, 2 ** 31]) assert.throws(() => client(async () => Response.json([]), { maxResponseBytes }), { code: 'INVALID_ARGUMENT' });
});

test('audit: timeout interrupts a hung response stream and closes its reader', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(client(async () => new Response(stream), { timeoutMs: 10 }).list('records'), { code: 'TIMEOUT' });
  assert.equal(cancelled, true);
  const abort = new AbortController();
  await assert.rejects(client(async () => { abort.abort(); return Response.json([]); }).list('records', { signal: abort.signal }), { code: 'ABORTED' });
});

test('audit: invalid UTF-8, missing bodies, and failing body streams return structured errors', async () => {
  for (const response of [new Response(new Uint8Array([0xff])), new Response(null), new Response(new ReadableStream({ start(controller) { controller.error(new Error('broken transport')); } }))]) {
    await assert.rejects(client(async () => response).list('records'), { code: 'INVALID_RESPONSE' });
  }
  let cancelled = false;
  await assert.rejects(client(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 503 })).list('records'), error => error.code === 'INDEXER_ERROR' && error.details.status === 503);
  assert.equal(cancelled, true);
});

test('audit: JSON complexity and transport-provided objects cannot exhaust recursive validation', async () => {
  let nested = 'leaf';
  for (let i = 0; i < 80; i++) nested = [nested];
  for (const value of [nested, Array.from({ length: 100_001 }, () => null)]) {
    await assert.rejects(client(async () => Response.json([record(value)])).list('records'), { code: 'INVALID_RESPONSE' });
  }
  const cyclic = {}; cyclic.self = cyclic;
  for (const value of [cyclic, new Date(), { n: Infinity }, { n: undefined }]) {
    await assert.rejects(client(async () => ({ ok: true, json: async () => [record(value)] })).list('records'), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(client(async () => ({ ok: true, json: async () => [Object.create(token)] })).list('guild_tokens'), { code: 'INVALID_RESPONSE' });
  const value = JSON.parse('{"__proto__":{"polluted":true},"nested":[1,true,null,"text"]}');
  assert.deepEqual((await client(async () => Response.json([record(value)])).list('records')).items[0].content_json, value);
  assert.equal({}.polluted, undefined);
});

test('audit: PostgREST quoted literals preserve control characters, quotes and injection text', async () => {
  const values = ['line\nbreak\tand\rcarriage', 'quoted"\\value', 'x),or(id.eq.secret)', 'a.b:c*'];
  for (const value of values) {
    await client(async url => {
      const eq = url.searchParams.get('tag').slice(3);
      const condition = url.searchParams.get('and').slice('(content.eq.'.length, -1);
      // PostgREST consumes backslash followed by any character; it is not JSON.
      const parseLiteral = input => input.slice(1, -1).replace(/\\([\s\S])/g, '$1');
      assert.equal(parseLiteral(eq), value);
      assert.equal(parseLiteral(condition), value);
      assert.equal(url.searchParams.size, 6);
      return Response.json([]);
    }).list('records', { filters: { tag: value }, where: [{ column: 'content', operator: 'eq', value }] });
  }
});

test('audit: paginated iterators terminate on non-progress and enforce caller request budgets', async () => {
  const repeated = client(async () => Response.json([token])).iterate('guild_tokens');
  assert.equal((await repeated.next()).value.id, 'token');
  await assert.rejects(repeated.next(), { code: 'INVALID_RESPONSE' });
  let requests = 0;
  const endless = client(async () => Response.json([{ ...token, id: String(requests++) }])).iterate('guild_tokens', { maxPages: 2 });
  await endless.next(); await endless.next();
  await assert.rejects(endless.next(), error => error.code === 'INDEXER_ERROR' && error.details.maxPages === 2);
  assert.equal(requests, 2);
  for (const maxPages of [0, -1, 0.5, Infinity]) await assert.rejects(client(async () => Response.json([])).iterate('guild_tokens', { maxPages }).next(), { code: 'INVALID_ARGUMENT' });
});

test('audit: compact projections preserve valid nullable database values', async () => {
  const dao = { id: DAO, name: null, avatar: NAV, shares_address: NAV, loot_address: USER, total_shares: null, total_loot: null };
  assert.deepEqual(await client(async () => Response.json([dao])).getDao(DAO), dao);
  const member = { id: `${DAO}-${USER}`, dao_id: DAO, member_address: USER, shares: null, loot: null, voting_power: null };
  assert.deepEqual((await client(async () => Response.json([member])).listMembers(DAO)).items[0], member);
  const proposal = { id: `${DAO}-1`, dao_id: DAO, proposal_id: 1, details: null, proposal_data: null, proposal_data_hash: 'hash', sponsored: null, processed: null, passed: null, action_failed: null, cancelled: null, yes_balance: null, no_balance: null };
  assert.deepEqual((await client(async () => Response.json([proposal])).listProposals(DAO)).items[0], proposal);
  for (const total_shares of ['01', '9'.repeat(79)]) {
    await assert.rejects(client(async () => Response.json([{ ...dao, total_shares }])).listDaos(), { code: 'INVALID_RESPONSE' });
  }
});

test('audit: every DAO-scoped lifecycle feed enforces DAO scope while preserving custom filters and ordering', async () => {
  const feeds = [
    ['listVotes', 'votes'], ['listNavigators', 'navigators'], ['listRagequits', 'ragequits'], ['listRecords', 'records'],
    ['listGuildTokens', 'guild_tokens'], ['listEventTransactions', 'event_transactions'], ['listDelegations', 'delegations'],
    ['listNavigatorEvents', 'navigator_events'], ['listNftClaims', 'nft_claims'], ['listSignalPolls', 'signal_polls'],
    ['listSignalVotes', 'signal_votes'], ['listTimelockChanges', 'timelock_changes'], ['listVestingSchedules', 'vesting_schedules'],
    ['listVestingClaims', 'vesting_claims'], ['listBudgets', 'budgets'], ['listBudgetDisbursements', 'budget_disbursements'],
    ['listSubscriptionMembers', 'subscription_members'], ['listSubscriptionPayments', 'subscription_payments'],
    ['listSubscriptionCollections', 'subscription_collections'], ['listVaultModuleEvents', 'vault_module_events'],
    ['listGovernanceConfigHistory', 'governance_config_history'],
  ];
  for (const [method, table] of feeds) {
    await client(async url => {
      assert.equal(url.pathname, `/rest/v1/ds_${table}`, method);
      assert.equal(url.searchParams.get('dao_id'), `eq.${DAO}`, method);
      assert.equal(url.searchParams.get('created_at'), 'eq."2026-09-09T00:00:00Z"', method);
      assert.equal(url.searchParams.get('order'), 'created_at.desc,id.asc', method);
      assert.equal(url.searchParams.get('offset'), '10');
      assert.equal(url.searchParams.get('limit'), '3');
      return Response.json([]);
    })[method](DAO, { filters: { dao_id: NAV, created_at: '2026-09-09T00:00:00Z' }, orderBy: 'created_at', direction: 'desc', offset: 10, limit: 3 });
  }
});

test('audit: remaining detail helpers use on-chain composite primary keys and complete projections', async () => {
  const calls = [
    ['getDaoDetails', [DAO], 'daos', DAO],
    ['getProposalDetails', [DAO, 3], 'proposals', `${DAO}-3`],
    ['getMember', [DAO, USER], 'members', `${DAO}-${USER}`],
    ['getNavigator', [DAO, NAV], 'navigators', `${DAO}-${NAV}`],
    ['getVote', [DAO, 3, USER], 'votes', `${DAO}-3-${USER}`],
    ['getNftClaim', [NAV, 0n], 'nft_claims', `${NAV}-0`],
    ['getSignalPoll', [NAV, 0n], 'signal_polls', `${NAV}-0`],
    ['getSignalVote', [NAV, 0n, USER], 'signal_votes', `${NAV}-0-${USER}`],
    ['getTimelockChange', [NAV, 0n], 'timelock_changes', `${NAV}-0`],
    ['getVestingSchedule', [NAV, 0n], 'vesting_schedules', `${NAV}-0`],
    ['getBudget', [NAV, 0n], 'budgets', `${NAV}-0`],
    ['getSubscriptionMember', [NAV, USER], 'subscription_members', `${NAV}-${USER}`],
    ['getStateDetails', [], 'indexer_state', '1'],
  ];
  for (const [method, args, table, id] of calls) {
    assert.equal(await client(async url => {
      assert.equal(url.pathname, `/rest/v1/ds_${table}`, method);
      assert.equal(url.searchParams.get('id'), `eq.${id}`, method);
      assert.equal(url.searchParams.get('limit'), '1');
      assert.ok(url.searchParams.get('select').split(',').length >= 7);
      return Response.json([]);
    })[method](...args), null);
  }
});

test('audit: freshness rejects implausible future checkpoints and validates explicit skew policy', () => {
  const future = { ...state, last_indexed_at: new Date(NOW + 60_001).toISOString() };
  assert.throws(() => assertIndexerHealthy(future, { chainId: 15000, nowMs: NOW, maxAgeMs: 0 }), { code: 'INVALID_RESPONSE' });
  assert.equal(assertIndexerHealthy(future, { chainId: 15000, nowMs: NOW, maxFutureSkewMs: 60_001 }).ageMs, 0);
  assert.throws(() => assertIndexerHealthy(state, { chainId: 15000, maxFutureSkewMs: 0 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => assertIndexerHealthy(state, { chainId: 15000, nowMs: NOW, maxFutureSkewMs: -1 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => assertIndexerHealthy({ ...state, reindex_reason: {} }, { chainId: 15000 }), { code: 'INVALID_RESPONSE' });
  assert.throws(() => assertIndexerHealthy({ ...state, last_block_number: '9'.repeat(100_000) }, { chainId: 15000 }), { code: 'INVALID_RESPONSE' });
  for (const last_indexed_at of ['0', '2026-09-09', '2026-09-09T00:00:00', '2026-99-99T99:99:99Z']) {
    assert.throws(() => assertIndexerHealthy({ ...state, last_indexed_at }, { chainId: 15000 }), { code: 'INVALID_RESPONSE' });
  }
});

test('audit: a checkpoint ages during polling instead of retaining a frozen freshness clock', async () => {
  let calls = 0;
  const reader = { async getStateDetails() {
    if (calls++ === 0) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
    return { ...state, last_block_number: '10' };
  } };
  await assert.rejects(waitForIndexedBlock(reader, 10n, { chainId: 15000, nowMs: NOW, maxAgeMs: 10, pollIntervalMs: 1, timeoutMs: 1000 }), error => error.code === 'INDEXER_ERROR' && error.details.reason === 'STALE');
});

test('audit: elapsed PostgREST deadlines cover synchronous fetch and parsing adapters', async () => {
  for (const count of [false, true]) {
    let signal;
    const sdk = client(async (_url, options) => {
      signal = options.signal;
      const end = performance.now() + 15;
      while (performance.now() < end) {}
      return count ? new Response(null, { headers: { 'content-range': '*/0' } }) : Response.json([]);
    }, { timeoutMs: 5 });
    await assert.rejects(count ? sdk.count('records') : sdk.list('records'), { code: 'TIMEOUT' });
    assert.equal(signal.aborted, true);
  }
});
