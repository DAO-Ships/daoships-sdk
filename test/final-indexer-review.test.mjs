import test from 'node:test';
import assert from 'node:assert/strict';
import { DaoShipsIndexer, indexerShapes } from '../dist/indexer.js';

const DAO = '0x0011111111111111111111111111111111111111';
const NAV = '0x0022222222222222222222222222222222222222';
const client = (fetch, options = {}) => new DaoShipsIndexer({ url: 'https://indexer.test', key: 'sb_publishable_fixture', schema: 'testnet', fetch, ...options });
const record = { id: 'record', dao_id: null, created_at: '2026-09-09T00:00:00Z', user_address: NAV, tx_hash: 'hash', tag: 'daoships.navigator.allowlist', content_type: 'application/json', content: '{}', content_json: { navigatorAddress: NAV }, trust_level: 'ON_CHAIN_PROVISIONAL', block_number: '123' };

test('final indexer: structured AND/OR supports active memberships and retains mandatory DAO scope', async () => {
  await client(async url => {
    assert.equal(url.searchParams.get('dao_id'), `eq.${DAO}`);
    assert.equal(url.searchParams.get('and'), '(or(shares.gt."0",loot.gt."0"))');
    return Response.json([]);
  }).listActiveMembers(DAO, { filters: { dao_id: NAV } });
  assert.throws(() => client(async () => { throw new Error('must not fetch'); }).list('members', { where: [{ column: 'dao_id', operator: 'not.is', value: null }] }), { code: 'INVALID_ARGUMENT' });
  await client(async url => {
    assert.equal(url.searchParams.get('and'), '(or(and(tag.eq."a",dao_id.not.is.null),dao_id.is.null))');
    return Response.json([]);
  }).list('records', { where: [{ any: [{ all: [{ column: 'tag', operator: 'eq', value: 'a' }, { column: 'dao_id', operator: 'not.is', value: null }] }, { column: 'dao_id', operator: 'is', value: null }] }] });
});

test('final indexer: JSON text paths target proposal reasons without downloading unrelated records', async () => {
  await client(async url => {
    assert.equal(url.searchParams.get('and'), '(content_json->>proposalId.eq."42",content_json->meta->>enabled.eq."true",content_json->>pollId.in.("9007199254740993","0"),content_json->>optional.is.null)');
    return Response.json([]);
  }).list('records', { where: [
    { column: 'content_json', path: ['proposalId'], operator: 'eq', value: 42 },
    { column: 'content_json', path: ['meta', 'enabled'], operator: 'eq', value: true },
    { column: 'content_json', path: ['pollId'], operator: 'in', value: [9007199254740993n, '0'] },
    { column: 'content_json', path: ['optional'], operator: 'is', value: null },
  ] });
});

test('final indexer: exact counts use HEAD, preserve large totals and obey row filters', async () => {
  for (const range of ['*/0', '*/9007199254740993', '0-0/9007199254740993']) {
    const result = await client(async (url, options) => {
      assert.equal(options.method, 'HEAD');
      assert.equal(options.headers.Prefer, 'count=exact');
      assert.equal(options.headers['Accept-Profile'], 'testnet');
      assert.equal(options.redirect, 'error');
      assert.equal(url.searchParams.get('select'), 'id');
      assert.equal(url.searchParams.get('limit'), '1');
      assert.equal(url.searchParams.get('dao_id'), `eq.${DAO}`);
      assert.equal(url.searchParams.get('and'), '(or(shares.gt."0",loot.gt."0"))');
      return new Response(null, { headers: { 'content-range': range } });
    }).countActiveMembers(DAO, { filters: { dao_id: NAV } });
    assert.equal(result, BigInt(range.split('/')[1]));
  }
});

test('final indexer: malformed, absent, approximate and inconsistent count ranges fail closed', async () => {
  for (const range of [null, '', '*/*', '0-1/*', '0-0/-1', '0-0/1.5', '0-0/01', '0-1/1', '1-0/10', '0-0/0', `*/${'9'.repeat(79)}`, '0-0/1junk']) {
    await assert.rejects(client(async () => new Response(null, { headers: range === null ? {} : { 'content-range': range } })).count('daos'), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(client(async () => new Response(null, { status: 403 })).count('daos'), error => error.code === 'INDEXER_ERROR' && error.details.status === 403);
});

test('final indexer: HEAD counts share deadline/cancellation protections with body queries', async () => {
  await assert.rejects(client(async () => new Promise(() => {}), { timeoutMs: 5 }).count('daos'), { code: 'TIMEOUT' });
  let fetched = false;
  await assert.rejects(client(async () => { fetched = true; return new Response(null, { headers: { 'content-range': '*/0' } }); }).count('daos', { signal: AbortSignal.abort() }), { code: 'ABORTED' });
  assert.equal(fetched, false);
  const controller = new AbortController();
  await assert.rejects(client(async () => { controller.abort(); return new Response(null, { headers: { 'content-range': '*/0' } }); }).count('daos', { signal: controller.signal }), { code: 'ABORTED' });
});

test('final indexer: explicit ilike patterns retain escaped wildcard literals and injection-like text', async () => {
  const pattern = '%100\\%\\_\\\\quoted"\n),or(id.eq.secret)%';
  await client(async url => {
    const encoded = url.searchParams.get('and').slice('(name.ilike.'.length, -1);
    assert.equal(encoded.slice(1, -1).replace(/\\([\s\S])/g, '$1'), pattern);
    assert.equal(url.searchParams.size, 5);
    return Response.json([]);
  }).list('daos', { where: [{ column: 'name', operator: 'ilike', value: pattern }] });
  await client(async url => {
    assert.equal(url.searchParams.get('and'), '(content_json->>name.ilike."%name%")');
    return Response.json([]);
  }).list('records', { where: [{ column: 'content_json', path: ['name'], operator: 'ilike', value: '%name%' }] });
});

test('final indexer: structural conditions reject injected paths, wrong field types, excessive depth and aggregate budgets', async () => {
  const sdk = client(async () => { throw new Error('must not fetch'); });
  let nested = { column: 'tag', operator: 'eq', value: 'x' };
  for (let i = 0; i < 6; i++) nested = { any: [nested] };
  const invalid = [
    { column: 'content_json', path: [], operator: 'eq', value: 'x' },
    { column: 'content_json', path: Array(2), operator: 'eq', value: 'x' },
    { column: 'tag', path: ['name'], operator: 'eq', value: 'x' },
    { column: 'content_json', path: ['name),id.eq.secret'], operator: 'eq', value: 'x' },
    { column: 'content_json', path: ['__proto__'], operator: 'eq', value: 'x' },
    { column: 'content_json', path: Array(9).fill('a'), operator: 'eq', value: 'x' },
    { column: 'content_json', path: ['proposalId'], operator: 'eq', value: Number.MAX_SAFE_INTEGER + 1 },
    { column: 'content_json', path: ['value'], operator: 'eq', value: {} },
    { column: 'block_number', operator: 'ilike', value: '%' },
    { column: 'tag', operator: 'is', value: null },
    { column: 'dao_id', operator: 'is', value: true },
    { any: [] }, { any: [{ column: 'tag', operator: 'eq', value: 'x' }], all: [] },
    { any: Array(2) }, nested,
    { column: 'tag', operator: 'in', value: Array(2) },
    { column: 'tag', operator: 'eq', value: 'x'.repeat(16_385) },
    { column: 'content_json', path: ['name'], operator: 'eq', value: 'x'.repeat(16_385) },
  ];
  for (const condition of invalid) assert.throws(() => sdk.list('records', { where: [condition] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => sdk.list('records', { where: Array(2) }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => sdk.list('records', { where: [{ column: 'tag', operator: 'in', value: Array(600).fill('a') }, { column: 'tag', operator: 'in', value: Array(600).fill('b') }] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => sdk.list('records', { where: Array.from({ length: 51 }, () => ({ any: [{ column: 'tag', operator: 'eq', value: 'x' }] })) }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(sdk.list('records', { where: [{ column: 'tag', operator: 'in', value: Array(1000).fill('x'.repeat(100)) }] }), { code: 'INVALID_ARGUMENT' });
});

test('final indexer: iteration snapshots filter identity and cancellation uses its original signal', async () => {
  const row = { id: 'token', dao_id: DAO, token_address: NAV, enabled: true, created_at: '2026-09-09T00:00:00Z', tx_hash: 'hash' };
  let calls = 0;
  const options = { filters: { dao_id: DAO }, where: [{ column: 'enabled', operator: 'eq', value: true }] };
  const iterator = client(async url => {
    assert.equal(url.searchParams.get('dao_id'), `eq.${DAO}`);
    assert.equal(url.searchParams.get('and'), '(enabled.eq."true")');
    return Response.json(calls++ === 0 ? [row] : []);
  }).iterate('guild_tokens', options);
  await iterator.next();
  options.filters.dao_id = NAV;
  options.where[0].value = false;
  assert.equal((await iterator.next()).done, true);
  assert.equal(calls, 2);
  const controller = new AbortController();
  const requestOptions = { signal: controller.signal };
  await assert.rejects(client(async () => {
    requestOptions.signal = new AbortController().signal;
    controller.abort();
    return Response.json([]);
  }).list('records', requestOptions), { code: 'ABORTED' });
  await assert.rejects(client(async () => Response.json([])).iterate('records', { where: [{ column: 'tag', operator: 'eq', value: () => 'x' }] }).next(), { code: 'INVALID_ARGUMENT' });
});

test('final indexer: allowlist discovery targets the navigator including orphan records and validates returned identity', async () => {
  const result = await client(async url => {
    assert.equal(url.searchParams.get('tag'), 'eq."daoships.navigator.allowlist"');
    assert.equal(url.searchParams.get('and'), `(or(dao_id.eq."${DAO}",dao_id.is.null),content_json->>navigatorAddress.eq."${NAV}")`);
    assert.equal(url.searchParams.get('order'), 'created_at.desc,id.asc');
    assert.equal(url.searchParams.get('limit'), '1');
    return Response.json([record]);
  }).getNavigatorAllowlist(DAO, NAV);
  assert.deepEqual(result, record);
  assert.equal(await client(async () => Response.json([])).getNavigatorAllowlist(DAO, NAV), null);
  for (const patch of [{ dao_id: NAV }, { tag: 'unrelated' }, { content_json: null }, { content_json: { navigatorAddress: DAO } }]) {
    await assert.rejects(client(async () => Response.json([{ ...record, ...patch }])).getNavigatorAllowlist(DAO, NAV), { code: 'INVALID_RESPONSE' });
  }
});

test('final indexer: proposal summaries omit encoded actions but retain precision and lifecycle fields', async () => {
  const row = Object.fromEntries(Object.entries(indexerShapes.proposals).filter(([key]) => key !== 'proposal_data').map(([key, kind]) => [key,
    kind.endsWith('?') ? null : kind === 'amount' ? '9007199254740993' : 'text',
  ]));
  const page = await client(async url => {
    assert.equal(url.searchParams.get('dao_id'), `eq.${DAO}`);
    assert.equal(url.searchParams.get('processed'), 'eq.false');
    const columns = url.searchParams.get('select').split(',');
    assert.ok(!columns.includes('proposal_data'));
    assert.ok(columns.includes('proposal_data_hash'));
    assert.ok(columns.includes('proposal_id::text'));
    return Response.json([row]);
  }).listProposalSummaries(DAO, { filters: { dao_id: NAV, processed: false }, orderBy: 'proposal_id', direction: 'desc' });
  assert.equal(page.items[0].proposal_id, '9007199254740993');
  assert.equal(Object.hasOwn(page.items[0], 'proposal_data'), false);
});
