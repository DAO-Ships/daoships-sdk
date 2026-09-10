import test from 'node:test';
import assert from 'node:assert/strict';
import { liveIndexerConfig, testLiveIndexer } from '../scripts/test-live-indexer.mjs';
import { indexerShapes } from '../dist/indexer.js';

const DAO = '0x0011111111111111111111111111111111111111', USER = '0x0022222222222222222222222222222222222222';
const environment = { SUPABASE_URL: 'https://acceptance.example.test', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_fixture', DAOSHIPS_INDEXER_SCHEMA: 'testnet', DAOSHIPS_CHAIN_ID: '15000' };
const fixture = (table, patch = {}) => ({ ...Object.fromEntries(Object.entries(indexerShapes[table]).map(([key, kind]) => [key, kind.endsWith('?') ? null : kind === 'integer' ? 1 : kind === 'boolean' ? false : kind === 'amount' ? '0' : kind === 'amount[]' ? '{}' : kind === 'string[]' ? [] : kind === 'json' ? {} : 'fixture'])), ...patch });
const state = fixture('indexer_state', { id: 1, chain_id: 15000, last_block_number: '100', last_block_hash: '0x' + '11'.repeat(32), last_indexed_at: new Date().toISOString(), is_syncing: false, requires_full_reindex: false });
function transport(tables = {}) {
  const requests = [];
  return { requests, fetch: async (input, init) => {
    const url = new URL(input), table = url.pathname.split('ds_')[1];
    assert.equal(url.origin, environment.SUPABASE_URL);
    assert.equal(init.redirect, 'error'); assert.ok(['GET', 'HEAD'].includes(init.method));
    assert.equal(init.body, undefined); assert.equal(init.headers.apikey, environment.SUPABASE_PUBLISHABLE_KEY);
    assert.equal(new Headers(init.headers).has('authorization'), false);
    assert.equal(init.signal.aborted, false);
    assert.ok(Object.hasOwn(indexerShapes, table));
    requests.push({ method: init.method, table });
    const rows = tables[table] ?? (table === 'indexer_state' ? [state] : []);
    if (init.method === 'HEAD') return new Response(null, { headers: { 'content-range': `*/${rows.length}` } });
    return Response.json(rows.slice(Number(url.searchParams.get('offset')), Number(url.searchParams.get('offset')) + Number(url.searchParams.get('limit'))));
  } };
}

test('live acceptance requires explicit HTTPS project, publishable key, schema and chain without fallbacks', async () => {
  assert.deepEqual(liveIndexerConfig(environment), { url: environment.SUPABASE_URL, key: environment.SUPABASE_PUBLISHABLE_KEY, schema: 'testnet', chainId: 15000, maxAgeMs: 300000 });
  let calls = 0;
  for (const name of Object.keys(environment)) {
    const missing = { ...environment }; delete missing[name];
    await assert.rejects(testLiveIndexer(missing, async () => { calls++; }), error => error.code === 'MISSING_CONFIGURATION' && error.stage === name);
  }
  for (const patch of [
    { SUPABASE_PUBLISHABLE_KEY: 'sb_secret_private' }, { SUPABASE_PUBLISHABLE_KEY: 'eyJlegacy-anon' }, { SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_x\nheader' },
    { SUPABASE_URL: 'http://acceptance.example.test' }, { SUPABASE_URL: 'https://user:password@example.test' }, { SUPABASE_URL: 'https://example.test?key=private' }, { SUPABASE_URL: 'invalid' },
    { DAOSHIPS_INDEXER_SCHEMA: 'testnet;DROP' }, { DAOSHIPS_CHAIN_ID: '0' }, { DAOSHIPS_CHAIN_ID: '15000oops' }, { DAOSHIPS_CHAIN_ID: '9007199254740992' },
    { DAOSHIPS_INDEXER_MAX_AGE_MS: '0' }, { DAOSHIPS_INDEXER_MAX_AGE_MS: '-1' }, { DAOSHIPS_INDEXER_MAX_AGE_MS: '9007199254740992' }, { DAOSHIPS_INDEXER_MAX_AGE_MS: '10 seconds' },
  ]) await assert.rejects(testLiveIndexer({ ...environment, ...patch }, async () => { calls++; }));
  assert.equal(calls, 0);
});

test('live acceptance refuses stale checkpoints by default and reports explicit historical-read age overrides', async () => {
  const now = Date.now(), oldTimestamp = new Date(now - 600_000).toISOString();
  const fake = transport({ indexer_state: [{ ...state, last_indexed_at: oldTimestamp }] });
  await assert.rejects(testLiveIndexer(environment, fake.fetch, now), { code: 'INDEXER_ERROR', stage: 'checkpoint-before', reason: 'STALE' });
  assert.equal(fake.requests.length, 1);
  const result = await testLiveIndexer({ ...environment, DAOSHIPS_INDEXER_MAX_AGE_MS: '900000' }, fake.fetch, now);
  assert.equal(result.checkpoints.maxAgeMs, 900000); assert.equal(result.checkpoints.before.lastIndexedAt, oldTimestamp);
  assert.equal(result.checkpoints.after.lastIndexedAt, oldTimestamp); assert.ok(result.checkpoints.before.ageMs >= 600_000);
  assert.ok(result.checkpoints.after.ageMs >= result.checkpoints.before.ageMs);
});

test('live acceptance reads all public projections/counts and labels empty feature areas unexercised', async () => {
  const fake = transport();
  const result = await testLiveIndexer(environment, fake.fetch);
  assert.equal(result.status, 'read-only-checks-passed'); assert.equal(result.chainId, 15000);
  assert.equal(result.projections.length, 25); assert.equal(result.requests, 52); assert.equal(fake.requests.length, 52);
  assert.deepEqual(fake.requests.filter(item => item.method === 'HEAD').map(item => item.table).sort(), Object.keys(indexerShapes).sort());
  assert.equal(result.unexercisedTables.length, 24); assert.equal(result.joins.daoProfile.exercised, false);
  assert.equal(result.joins.memberProfile.exercised, false); assert.equal(result.joins.proposal.exercised, false);
  assert.equal(result.checkpointStable, true); assert.equal(result.maxRequests, 80);
  const report = JSON.stringify(result);
  assert.equal(report.includes(environment.SUPABASE_PUBLISHABLE_KEY), false); assert.equal(report.includes(environment.SUPABASE_URL), false);
  assert.ok(result.limitations.some(item => item.includes('not complete feature coverage')));
});

test('live acceptance exercises bounded joins only from real samples and reports their incompleteness', async () => {
  const fake = transport({
    daos: [fixture('daos', { id: DAO, avatar: USER, deployer: USER, name: 'PRIVATE_INDEXED_CONTENT' })],
    members: [fixture('members', { id: `${DAO}-${USER}`, dao_id: DAO, member_address: USER })],
    proposals: [fixture('proposals', { id: `${DAO}-1`, dao_id: DAO, proposal_id: '1' })],
    votes: Array.from({ length: 3 }, (_, i) => {
      const voter = `0x00${String(i + 3).repeat(38)}`;
      return fixture('votes', { id: `${DAO}-1-${voter}`, dao_id: DAO, proposal_id: `${DAO}-1`, voter, approved: true });
    }),
  });
  const result = await testLiveIndexer(environment, fake.fetch);
  assert.equal(result.joins.daoProfile.exercised, true); assert.equal(result.joins.memberProfile.exercised, true);
  assert.equal(result.joins.proposal.exercised, true); assert.equal(result.joins.proposal.complete, false);
  assert.equal(result.joins.proposal.sampledVotes, 3); assert.ok(result.requests <= 80);
  const report = JSON.stringify(result);
  for (const content of ['PRIVATE_INDEXED_CONTENT', DAO, USER, environment.SUPABASE_PUBLISHABLE_KEY]) assert.equal(report.includes(content), false);
});

test('live acceptance fails closed on wrong-chain checkpoints, malformed exact numerics and transport errors without exposing secrets', async () => {
  let requests = 0;
  await assert.rejects(testLiveIndexer(environment, async () => { requests++; return Response.json([{ ...state, chain_id: 9 }]); }), { code: 'CHAIN_MISMATCH', stage: 'checkpoint-before' });
  assert.equal(requests, 1);
  const malformed = transport({ members: [fixture('members', { shares: 9007199254740993 })] });
  await assert.rejects(testLiveIndexer(environment, malformed.fetch), { code: 'INVALID_RESPONSE', stage: 'public-projections' });
  await assert.rejects(testLiveIndexer(environment, async () => { throw new Error(`remote failure ${environment.SUPABASE_PUBLISHABLE_KEY}`); }), error => {
    assert.equal(error.code, 'INDEXER_ERROR'); assert.equal(error.cause, undefined);
    assert.equal(String(error).includes(environment.SUPABASE_PUBLISHABLE_KEY), false); return true;
  });
});
