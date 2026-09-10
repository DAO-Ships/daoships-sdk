import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DaoShipsIndexer, indexerShapes, indexerRecordOrderingShape } from '../dist/indexer.js';

const DAO = '0x0011111111111111111111111111111111111111';
const NAV = '0x0022222222222222222222222222222222222222';
const WALLET = '0x0033333333333333333333333333333333333333';
const LARGE = '115792089237316195423570985008687907853269984665640564039457584007913129639935';
const client = (fetch, options = {}) => new DaoShipsIndexer({ url: 'https://indexer.test', key: 'sb_publishable_test', schema: 'testnet', fetch, ...options });
const hasCode = code => error => error.code === code;

// This is a transport fixture. Independent assertions below verify the actual public schema,
// precision-sensitive values and lifecycle key formats rather than duplicating implementation.
function fixture(shape) {
  return Object.fromEntries(Object.entries(shape).map(([key, kind]) => [key,
    kind.endsWith('?') ? null : kind === 'integer' ? 1 : kind === 'boolean' ? true
      : kind === 'amount' ? LARGE : kind === 'amount[]' ? `{${LARGE},0}`
      : kind === 'string[]' ? ['one', 'two'] : kind === 'json' ? { message: 'data' } : 'value',
  ]));
}

test('baseline and opt-in projections cover exactly the 25 public indexer tables and all their SQL columns', async t => {
  let source;
  try { source = await readFile(new URL('../../daoships-indexer/supabase/migrations/schema.sql', import.meta.url), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') { t.skip('Sibling indexer schema is unavailable in standalone checkout.'); return; } throw error; }
  const tables = [...source.matchAll(/CREATE TABLE IF NOT EXISTS %I\.ds_(\w+) \(\n([\s\S]*?)\n        \)/g)]
    .filter(([, name]) => !['processed_logs', 'navigator_sanction_intents'].includes(name));
  assert.equal(tables.length, 25);
  assert.deepEqual(Object.keys(indexerShapes).sort(), tables.map(([, name]) => name).sort());
  for (const [, table, body] of tables) {
    const shape = table === 'records' ? { ...indexerShapes.records, ...indexerRecordOrderingShape } : indexerShapes[table];
    const columns = body.split('\n').map(line => line.trim()).filter(line => /^[a-z_]+ (?:VARCHAR|TEXT|NUMERIC|BIGINT|INTEGER|SMALLINT|SERIAL|TIMESTAMPTZ|BOOLEAN|JSONB|public\.)/.test(line));
    assert.deepEqual(Object.keys(shape).sort(), columns.map(line => line.split(' ')[0]).sort(), table);
    for (const column of columns) {
      const name = column.split(' ')[0];
      const kind = shape[name];
      if (/ NUMERIC| BIGINT/.test(column)) assert.ok(kind.startsWith('amount'), `${table}.${name} must remain exact`);
      if (/ NUMERIC\(78, 0\)\[\]/.test(column)) assert.ok(kind.startsWith('amount[]'));
      const nullable = !/NOT NULL|PRIMARY KEY|SERIAL/.test(column.split('--')[0]);
      assert.equal(kind.endsWith('?'), nullable, `${table}.${name} nullability`);
    }
  }
});

test('every full projection casts all SQL numerics before parsing, with deterministic sorting', async () => {
  for (const [table, shape] of Object.entries(indexerShapes)) {
    const row = fixture(shape);
    const sdk = client(async url => {
      assert.equal(url.pathname, `/rest/v1/ds_${table}`);
      assert.equal(url.searchParams.get('order'), 'id.asc');
      const selected = url.searchParams.get('select').split(',');
      for (const [column, kind] of Object.entries(shape)) {
        assert.ok(selected.includes(kind.startsWith('amount') ? `${column}::text` : column), `${table}.${column}`);
      }
      return Response.json([row]);
    });
    const page = await sdk.list(table);
    assert.equal(page.items.length, 1);
    assert.equal(page.source, 'indexer');
    assert.equal(page.nextOffset, 1);
  }
});

test('signal tally preserves 256-bit option weights and nullable labels', async () => {
  const row = { ...fixture(indexerShapes.signal_polls), id: `${NAV}-0`, navigator_address: NAV, poll_id: '0',
    option_count: 2, tally: `{${LARGE},9007199254740993}`, options: ['Approve', 'Reject'] };
  const poll = await client(async () => Response.json([row])).getSignalPoll(NAV, 0n);
  assert.deepEqual(poll.tally, [LARGE, '9007199254740993']);
  assert.deepEqual(poll.options, ['Approve', 'Reject']);
  assert.equal(poll.labels_block_number, null);
  for (const invalid of [[9007199254740993, 0], '1,2', '{1,NULL}', '{1.5,2}', '{-1,2}']) {
    await assert.rejects(client(async () => Response.json([{ ...row, tally: invalid }])).getSignalPoll(NAV, '0'), hasCode('INVALID_RESPONSE'));
  }
});

test('schema nullability is preserved and lossy or malformed numeric values are rejected', async () => {
  const row = fixture(indexerShapes.vesting_schedules);
  assert.equal((await client(async () => Response.json([row])).getVestingSchedule(NAV, '0')).vested_at_revoke, null);
  for (const invalid of [9007199254740993, '1.0', '-1', undefined, null]) {
    await assert.rejects(client(async () => Response.json([{ ...row, total_amount: invalid }])).getVestingSchedule(NAV, '0'), hasCode('INVALID_RESPONSE'));
  }
});

test('named detail methods use actual handler composite primary keys including zero and uint256 IDs', async () => {
  const seen = [];
  const sdk = client(async url => { seen.push([url.pathname, url.searchParams.get('id')]); return Response.json([]); });
  await sdk.getNavigator(DAO, NAV);
  await sdk.getMember(DAO, WALLET);
  await sdk.getVote(DAO, 1, WALLET);
  await sdk.getSignalPoll(NAV, LARGE);
  await sdk.getSignalVote(NAV, 0n, WALLET);
  await sdk.getSubscriptionMember(NAV, WALLET);
  await sdk.getBudget(NAV, 0n);
  await sdk.getTimelockChange(NAV, 0n);
  await sdk.getVestingSchedule(NAV, 0n);
  await sdk.getNftClaim(NAV, LARGE);
  assert.deepEqual(seen, [
    ['navigators', `${DAO}-${NAV}`], ['members', `${DAO}-${WALLET}`], ['votes', `${DAO}-1-${WALLET}`],
    ['signal_polls', `${NAV}-${LARGE}`], ['signal_votes', `${NAV}-0-${WALLET}`], ['subscription_members', `${NAV}-${WALLET}`],
    ['budgets', `${NAV}-0`], ['timelock_changes', `${NAV}-0`], ['vesting_schedules', `${NAV}-0`], ['nft_claims', `${NAV}-${LARGE}`],
  ].map(([table, id]) => [`/rest/v1/ds_${table}`, `eq.${id}`]));
  for (const id of ['01', '-1', '1.2', '1),id.gt.0', 1, 1n << 256n]) {
    assert.throws(() => sdk.getBudget(NAV, id), hasCode('INVALID_ARGUMENT'));
  }
});

test('typed filters scope feeds, preserve trusted selection, sort ties, and reject query syntax columns', async () => {
  const sdk = client(async url => {
    assert.equal(url.searchParams.get('dao_id'), `eq.${DAO}`);
    assert.equal(url.searchParams.get('trust_status'), 'eq.sanctioned');
    assert.equal(url.searchParams.get('navigator_type'), 'eq.BudgetNavigator');
    assert.equal(url.searchParams.get('order'), 'created_at.desc,id.asc');
    return Response.json([]);
  });
  await sdk.listSanctionedNavigators(DAO, { filters: { trust_status: 'self_asserted', dao_id: NAV, navigator_type: 'BudgetNavigator' }, orderBy: 'created_at', direction: 'desc' });
  for (const options of [{ filters: { 'or': '(id.eq.x)' } }, { orderBy: 'id.desc,evil' }, { direction: 'wrong' }, { filters: { config: {} } }]) {
    assert.throws(() => sdk.list('navigators', options), hasCode('INVALID_ARGUMENT'));
  }
  assert.throws(() => sdk.list('processed_logs'), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => sdk.list('__proto__'), hasCode('INVALID_ARGUMENT'));
  await client(async url => {
    assert.equal(url.searchParams.get('dao_id'), 'is.null');
    return Response.json([]);
  }).list('records', { filters: { dao_id: null } });
  await client(async url => {
    assert.equal(url.searchParams.get('poll_id'), `eq.${LARGE}`);
    return Response.json([]);
  }).listPollVotes(NAV, BigInt(LARGE));
});

test('iterator follows server page caps to exhaustion and cancels between yielded rows', async () => {
  const offsets = [];
  const row = fixture(indexerShapes.guild_tokens);
  const sdk = client(async url => {
    const offset = Number(url.searchParams.get('offset')); offsets.push(offset);
    return Response.json(offset < 3 ? [{ ...row, id: String(offset) }] : []);
  });
  const rows = [];
  for await (const item of sdk.iterate('guild_tokens', { limit: 100 })) rows.push(item.id);
  assert.deepEqual(rows, ['0', '1', '2']);
  assert.deepEqual(offsets, [0, 1, 2, 3]);
  const abort = new AbortController();
  const iterator = client(async () => Response.json([row, row])).iterate('guild_tokens', { signal: abort.signal });
  await iterator.next(); abort.abort();
  await assert.rejects(iterator.next(), hasCode('ABORTED'));
});

test('timeouts cover fetch and response body even for transports that ignore abort', async () => {
  await assert.rejects(client(async () => new Promise(() => {}), { timeoutMs: 5 }).list('budgets'), hasCode('TIMEOUT'));
  await assert.rejects(client(async () => ({ ok: true, json: () => new Promise(() => {}) }), { timeoutMs: 5 }).list('budgets'), hasCode('TIMEOUT'));
  await assert.rejects(client(async () => { throw new Error('must not fetch'); }).list('budgets', { signal: AbortSignal.abort() }), hasCode('ABORTED'));
  await assert.rejects(client(async () => new Response('{invalid json')).list('budgets'), hasCode('INVALID_RESPONSE'));
  await assert.rejects(client(async () => new Response('failure', { status: 429 })).list('budgets'), error => error.code === 'INDEXER_ERROR' && error.details.status === 429 && error.details.table === 'ds_budgets');
});

test('AND conditions support exact block ranges and safely quote metadata selection values', async () => {
  const unusualTag = 'quoted"),or(id.eq.injected),tag.eq.(\\';
  const sdk = client(async url => {
    assert.equal(url.searchParams.get('and'), `(block_number.gte."9007199254740993",block_number.lt."9007199254740999",tag.in.("VERIFIED",${JSON.stringify(unusualTag)}))`);
    return Response.json([]);
  });
  await sdk.list('records', { where: [
    { column: 'block_number', operator: 'gte', value: 9007199254740993n },
    { column: 'block_number', operator: 'lt', value: '9007199254740999' },
    { column: 'tag', operator: 'in', value: ['VERIFIED', unusualTag] },
  ] });
  for (const where of [
    [{ column: 'block_number', operator: 'gte', value: 9007199254740993 }],
    [{ column: 'tag', operator: 'in', value: [] }],
    [{ column: 'tag', operator: 'or', value: 'a' }],
    [{ column: 'id),or(id', operator: 'eq', value: 'a' }],
    [{ column: 'dao_id', operator: 'eq', value: null }],
  ]) assert.throws(() => sdk.list('records', { where }), hasCode('INVALID_ARGUMENT'));
});
