import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchIpfsAllowlist, publishAllowlist, validateAllowlistCid, watchIndexer, supabaseRealtimeAdapter, DaoShipsData } from '../dist/data-integrations.js';
import { buildAllowlistTree, verifyAllowlistProof } from '../dist/allowlist.js';
import { DaoShipsIndexer, indexerShapes } from '../dist/indexer.js';

const DAO = '0x0011111111111111111111111111111111111111', NAV = '0x0022222222222222222222222222222222222222', USER = '0x0033333333333333333333333333333333333333';
const OTHER = '0x0044444444444444444444444444444444444444';
const tree = buildAllowlistTree([DAO, NAV, USER]);
const root = tree.tree[0];
const encode58 = bytes => { let value = BigInt(`0x${Buffer.from(bytes).toString('hex')}`), text = ''; while (value) { text = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'[Number(value % 58n)] + text; value /= 58n; } return text; };
const CID = encode58([0x12, 0x20, ...Array(32).fill(0)]);
const base32 = bytes => { let bits = ''; for (const byte of bytes) bits += byte.toString(2).padStart(8, '0'); bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0'); return 'b' + bits.match(/.{5}/g).map(part => 'abcdefghijklmnopqrstuvwxyz234567'[parseInt(part, 2)]).join(''); };
const CID1 = base32([1, 0x70, 0x12, 0x20, ...Array(32).fill(0)]);
const fixture = (table, patch = {}) => ({ ...Object.fromEntries(Object.entries(indexerShapes[table]).map(([key, kind]) => [key, kind.endsWith('?') ? null : kind === 'integer' ? 1 : kind === 'boolean' ? false : kind === 'amount' ? '0' : kind === 'string[]' ? [] : kind === 'json' ? {} : 'value'])), ...patch });
const state = fixture('indexer_state', { id: 1, chain_id: 15000, last_block_number: '100', last_block_hash: '0x' + 'ab'.repeat(32), last_indexed_at: '2026-09-09T00:00:00Z', is_syncing: false, requires_full_reindex: false });
const sdk = fetch => new DaoShipsIndexer({ url: 'https://indexer.test', key: 'public', schema: 'testnet', fetch });
const indexerFor = (tables, checkpoint = () => state) => sdk(async url => {
  const table = url.pathname.split('ds_')[1], offset = Number(url.searchParams.get('offset')), limit = Number(url.searchParams.get('limit'));
  return Response.json(table === 'indexer_state' ? [checkpoint()] : (tables[table] ?? []).slice(offset, offset + limit));
});
const readOptions = { chainId: 15000, timeoutMs: 1000, pageSize: 10, maxRows: 100, maxPages: 10 };
const ipfsOptions = { cid: CID, gateway: 'https://gateway.test', account: USER, readRoot: async () => root, fetch: async () => Response.json(tree) };

test('IPFS: supported CIDs, gateway isolation and caller-chain-root proofs are verified', async () => {
  assert.equal(validateAllowlistCid(CID), CID); assert.equal(validateAllowlistCid(CID1), CID1);
  let reads = 0;
  const result = await fetchIpfsAllowlist({ ...ipfsOptions, cid: CID1, gateway: 'https://gateway.test/prefix/ipfs/', expectedRoot: root, readRoot: async () => { reads++; return root; }, fetch: async (url, options) => {
    assert.equal(url.href, `https://gateway.test/prefix/ipfs/${CID1}`);
    assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, undefined);
    return Response.json({ treeDump: tree });
  } });
  assert.equal(reads, 2); assert.equal(result.member, true); assert.equal(result.verifiedAgainst, 'caller-chain-root');
  assert.equal(verifyAllowlistProof(root, USER, result.proof), true);
  assert.equal((await fetchIpfsAllowlist({ ...ipfsOptions, account: OTHER })).proof, null);
  for (const cid of ['../secret', `${CID}/file`, 'ipfs://' + CID, 'b' + 'a'.repeat(58), base32([1, 0x71, 0x12, 0x20, ...Array(32).fill(0)])]) assert.throws(() => validateAllowlistCid(cid), { code: 'INVALID_ARGUMENT' });
  for (const gateway of ['https://user:secret@gateway.test', 'https://gateway.test?key=secret', 'file:///tmp/file', 'invalid']) await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, gateway }), { code: 'INVALID_ARGUMENT' });
});

test('IPFS: corrupt/mismatching trees and root changes fail before any proof is returned', async () => {
  const different = buildAllowlistTree([OTHER]).tree[0];
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, expectedRoot: different }), { code: 'HASH_MISMATCH' });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, readRoot: async () => different }), { code: 'HASH_MISMATCH' });
  let reads = 0;
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, readRoot: async () => reads++ ? different : root }), { code: 'PLAN_CHANGED' });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, fetch: async () => Response.json({ ...tree, tree: ['invalid'] }) }), { code: 'INVALID_RESPONSE' });
  for (const value of ['0x' + '0'.repeat(64), 'wrong']) await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, readRoot: async () => value }), { code: 'INVALID_RESPONSE' });
});

test('IPFS: streamed byte limits, malformed responses, hung readers and cancellation are bounded', async () => {
  const text = JSON.stringify(tree);
  assert.equal((await fetchIpfsAllowlist({ ...ipfsOptions, maxBytes: Buffer.byteLength(text), fetch: async () => new Response(text) })).member, true);
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, maxBytes: Buffer.byteLength(text) - 1 }), { code: 'INVALID_RESPONSE' });
  let cancelled = false;
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, maxBytes: 10, fetch: async () => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(20)); }, cancel() { cancelled = true; } })) }), { code: 'INVALID_RESPONSE' });
  assert.equal(cancelled, true);
  for (const response of [new Response(null), new Response('not JSON'), new Response(new Uint8Array([255])), new Response('{}', { headers: { 'content-length': '999999999' } })]) await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, fetch: async () => response }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, fetch: async () => new Response(null, { status: 502 }) }), error => error.code === 'INDEXER_ERROR' && error.details.status === 502);
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, timeoutMs: 5, readRoot: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, signal: AbortSignal.abort() }), { code: 'ABORTED' });
});

test('joined DAO profile uses materialized fields and the correct vault-authored record', async () => {
  const dao = fixture('daos', { id: DAO, avatar: NAV, deployer: USER, name: 'Current', description: null, avatar_img: null, profile_source: 'vault' });
  const profile = fixture('records', { id: 'profile', dao_id: DAO, user_address: NAV, tag: 'daoships.dao.profile', trust_level: 'VERIFIED', content_json: { schemaVersion: '1.0', daoAddress: DAO, name: 'Old record field', banner: 'https://example.test/banner', theme: { primary: '#123' } } });
  const result = await new DaoShipsData(indexerFor({ daos: [dao], records: [profile] })).getDaoProfile(DAO, readOptions);
  assert.equal(result.metadata.name, 'Current'); assert.equal(result.metadata.banner, 'https://example.test/banner');
  assert.equal(result.metadata.description, null); assert.equal(result.checkpointStable, true); assert.equal(result.atomic, false); assert.equal(result.trust, 'indexer-claims-only'); assert.equal(result.complete, true);
  for (const patch of [{ trust_level: 'UNTRUSTED' }, { user_address: OTHER }, { tag: 'daoships.dao.profile.initial' }, { content_json: { schemaVersion: '1.0', daoAddress: OTHER } }]) await assert.rejects(new DaoShipsData(indexerFor({ daos: [dao], records: [{ ...profile, ...patch }] })).getDaoProfile(DAO, readOptions), { code: 'INVALID_RESPONSE' });
  const missing = await new DaoShipsData(indexerFor({ daos: [dao] })).getDaoProfile(DAO, readOptions);
  assert.equal(missing.complete, false); assert.equal(missing.profile, null);
  const bannerOnly = await new DaoShipsData(indexerFor({ daos: [{ ...dao, profile_source: 'launcher' }], records: [{ ...profile, content_json: { schemaVersion: '1.0', daoAddress: DAO, banner: 'https://example.test/new-banner' } }] })).getDaoProfile(DAO, readOptions);
  assert.equal(bannerOnly.metadata.banner, 'https://example.test/new-banner');
  assert.equal(bannerOnly.metadata.name, 'Current');
});

test('joined membership rejects identity/profile mismatches and reports absent membership without inventing data', async () => {
  const member = fixture('members', { id: `${DAO}-${USER}`, dao_id: DAO, member_address: USER, shares: '9007199254740993' });
  const profile = fixture('records', { id: 'profile', dao_id: DAO, user_address: USER, tag: 'daoships.member.profile', trust_level: 'MEMBER', content_json: { schemaVersion: '1.0', daoAddress: DAO, name: 'Crew' } });
  const joined = await new DaoShipsData(indexerFor({ members: [member], records: [profile] })).getMemberProfile(DAO, USER, readOptions);
  assert.equal(joined.member.shares, '9007199254740993'); assert.equal(joined.profile.content_json.name, 'Crew');
  await assert.rejects(new DaoShipsData(indexerFor({ members: [{ ...member, member_address: OTHER }] })).getMemberProfile(DAO, USER, readOptions), { code: 'INVALID_RESPONSE' });
  await assert.rejects(new DaoShipsData(indexerFor({ members: [member], records: [{ ...profile, trust_level: 'UNTRUSTED' }] })).getMemberProfile(DAO, USER, readOptions), { code: 'INVALID_RESPONSE' });
  assert.equal((await new DaoShipsData(indexerFor({})).getMemberProfile(DAO, USER, readOptions)).member, null);
});

test('joined proposal reasons require a matching indexed vote, identity, trust and consistent vote choice', async () => {
  const proposal = fixture('proposals', { id: `${DAO}-1`, dao_id: DAO, proposal_id: '1' });
  const vote = fixture('votes', { id: `${DAO}-1-${USER}`, dao_id: DAO, proposal_id: `${DAO}-1`, voter: USER, approved: true, balance: '9007199254740993' });
  const reason = fixture('records', { id: 'reason', dao_id: DAO, user_address: USER, tag: 'daoships.proposal.vote.reason', trust_level: 'MEMBER', content_json: { schemaVersion: '1.0', daoAddress: DAO, proposalId: 1, vote: true, reason: 'Support' } });
  const records = [reason, { ...reason, id: 'unvoted', user_address: OTHER }, { ...reason, id: 'wrongChoice', content_json: { ...reason.content_json, vote: false } }, { ...reason, id: 'untrusted', trust_level: 'UNTRUSTED' }];
  const result = await new DaoShipsData(indexerFor({ proposals: [proposal], votes: [vote], records })).getProposal(DAO, 1, readOptions);
  assert.equal(result.reasons.length, 1); assert.equal(result.excludedReasonCount, 3); assert.equal(result.votes.items[0].balance, '9007199254740993');
  assert.equal(result.complete, true); assert.equal(result.reasonVerification, 'matched-indexed-vote-and-poster-schema');
  await assert.rejects(new DaoShipsData(indexerFor({ votes: [{ ...vote, id: 'wrong' }] })).getProposal(DAO, 1, readOptions), { code: 'INVALID_RESPONSE' });
  const failed = sdk(async url => { if (url.pathname.endsWith('ds_votes')) return new Response(null, { status: 503 }); return Response.json(url.pathname.endsWith('ds_indexer_state') ? [state] : []); });
  await assert.rejects(new DaoShipsData(failed).getProposal(DAO, 1, readOptions), { code: 'INDEXER_ERROR' });
});

test('joined reads expose truncation/checkpoint drift and refuse wrong-chain or reindex states', async () => {
  const vote = fixture('votes', { id: `${DAO}-1-${USER}`, dao_id: DAO, proposal_id: `${DAO}-1`, voter: USER });
  let reads = 0;
  const result = await new DaoShipsData(indexerFor({ votes: [vote] }, () => ({ ...state, last_block_number: String(100 + reads++) }))).getProposal(DAO, 1, { ...readOptions, maxRows: 1 });
  assert.equal(result.complete, false); assert.equal(result.votes.reason, 'row_limit'); assert.equal(result.checkpointStable, false);
  const paged = await new DaoShipsData(indexerFor({ votes: [vote] })).getProposal(DAO, 1, { ...readOptions, maxPages: 1 });
  assert.equal(paged.votes.reason, 'page_limit');
  for (const [patch, code] of [[{ chain_id: 1 }, 'CHAIN_MISMATCH'], [{ requires_full_reindex: true }, 'INDEXER_ERROR']]) await assert.rejects(new DaoShipsData(indexerFor({}, () => ({ ...state, ...patch }))).getProposal(DAO, 1, readOptions), { code });
  await assert.rejects(new DaoShipsData(indexerFor({})).getProposal(DAO, 1, { ...readOptions, signal: AbortSignal.abort() }), { code: 'ABORTED' });
});

test('realtime coalesces changes, refetches exact rows on update/delete/reorg/reconnect, and unsubscribes', async () => {
  let rows = [fixture('members', { id: `${DAO}-${USER}`, dao_id: DAO, member_address: USER, shares: '1' })], calls = 0, callbacks, cleanups = 0, subscriptionSignal;
  const updates = [], errors = [];
  const indexer = sdk(async url => { calls++; return Response.json(Number(url.searchParams.get('offset')) === 0 ? rows : []); });
  const watch = await watchIndexer(indexer, 'members', { schema: 'testnet', debounceMs: 10, subscribe: (value, signal) => { callbacks = value; subscriptionSignal = signal; return () => { cleanups++; }; }, onSnapshot: value => { updates.push(value); }, onError: error => errors.push(error) });
  const initialCalls = calls;
  rows = [{ ...rows[0], shares: '9007199254740993' }];
  for (let i = 0; i < 1000; i++) callbacks.onChange({ schema: 'testnet', table: 'ds_members', eventType: 'UPDATE', new: { shares: 9007199254740993 } });
  await watch.refresh();
  assert.equal(calls - initialCalls, 2); assert.equal(watch.snapshot.items[0].shares, '9007199254740993');
  rows = [];
  callbacks.onChange({ schema: 'testnet', table: 'ds_members', eventType: 'DELETE', old: { id: `${DAO}-${USER}` } });
  await watch.refresh(); assert.equal(watch.snapshot.items.length, 0);
  callbacks.onReorg(); callbacks.onReconnect(); await watch.refresh();
  callbacks.onChange({ schema: 'wrong', table: 'ds_members', eventType: 'INSERT' });
  assert.equal(errors.at(-1).code, 'INVALID_RESPONSE');
  await watch.close(); await watch.close();
  assert.equal(cleanups, 1); assert.equal(subscriptionSignal.aborted, true);
  const seen = updates.length; callbacks.onReconnect(); callbacks.onError(new Error('late')); assert.equal(updates.length, seen);
  await assert.rejects(watch.refresh(), { code: 'ABORTED' });
});

test('realtime refuses lossy refetch rows, exposes incomplete snapshots and bounds slow subscriptions', async () => {
  let malformed = false, cleanup = 0;
  const row = fixture('members', { id: 'member', shares: '1' });
  const indexer = sdk(async () => Response.json([{ ...row, shares: malformed ? 9007199254740993 : '1' }]));
  const watch = await watchIndexer(indexer, 'members', { schema: 'testnet', maxRows: 1, subscribe: () => () => { cleanup++; }, onSnapshot: () => {} });
  assert.equal(watch.snapshot.complete, false); assert.equal(watch.snapshot.reason, 'row_limit');
  malformed = true;
  await assert.rejects(watch.refresh(), { code: 'INVALID_RESPONSE' }); assert.equal(watch.lastError.code, 'INVALID_RESPONSE');
  assert.equal(watch.snapshot.items[0].shares, '1'); await watch.close(); assert.equal(cleanup, 1);
  await assert.rejects(watchIndexer(indexer, 'members', { schema: 'testnet', timeoutMs: 5, subscribe: () => new Promise(() => {}), onSnapshot: () => {} }), { code: 'TIMEOUT' });
  await assert.rejects(watchIndexer(indexer, 'members', { schema: 'testnet', signal: AbortSignal.abort(), subscribe: () => () => {}, onSnapshot: () => {} }), { code: 'ABORTED' });
});

test('realtime invalidations during a read force another snapshot and late subscription cleanup is retained', async () => {
  let callbacks, first = true, reads = 0, resolveSecond;
  const second = new Promise(resolve => { resolveSecond = resolve; });
  const snapshots = [];
  const watch = await watchIndexer(sdk(async () => {
    reads++;
    if (first) { first = false; callbacks.onChange({ schema: 'testnet', table: 'ds_records', eventType: 'INSERT', new: { block_number: Number.MAX_VALUE } }); }
    return Response.json([]);
  }), 'records', { schema: 'testnet', debounceMs: 10, subscribe: value => { callbacks = value; return () => {}; }, onSnapshot: value => { snapshots.push(value); if (snapshots.length === 2) resolveSecond(); } });
  assert.equal(watch.snapshot.invalidatedDuringRead, true);
  await second;
  assert.equal(reads, 2); assert.equal(watch.snapshot.invalidatedDuringRead, false); await watch.close();
  let cleanups = 0, release;
  const late = new Promise(resolve => { release = resolve; });
  await assert.rejects(watchIndexer(indexerFor({}), 'records', { schema: 'testnet', timeoutMs: 5, subscribe: () => late, onSnapshot: () => {} }), { code: 'TIMEOUT' });
  release(() => { cleanups++; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(cleanups, 1);
});

test('realtime abort closes the transport and repeated close calls await the same cleanup', async () => {
  const abort = new AbortController(); let releases = 0, finish;
  const cleanup = new Promise(resolve => { finish = resolve; });
  const watch = await watchIndexer(indexerFor({}), 'records', { schema: 'testnet', signal: abort.signal, subscribe: () => async () => { releases++; await cleanup; }, onSnapshot: () => {} });
  abort.abort();
  let closed = false;
  const closing = watch.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(closed, false); assert.equal(releases, 1);
  finish(); await closing; assert.equal(closed, true);
});

test('pinning adapter receives bounded canonical JSON and reports storage claims without root attestation', async () => {
  let calls = 0;
  const result = await publishAllowlist({ ...tree, ignored: 'not uploaded' }, { pin: async (document, signal) => {
    calls++; assert.equal(signal.aborted, false); assert.equal(document.filename, 'allowlist.json'); assert.equal(document.contentType, 'application/json');
    const uploaded = JSON.parse(new TextDecoder().decode(document.content));
    assert.deepEqual(uploaded, tree); assert.equal(Object.hasOwn(uploaded, 'ignored'), false);
    return { cid: CID };
  } });
  assert.equal(calls, 1); assert.equal(result.root, root); assert.equal(result.memberCount, 3);
  assert.equal(result.verification, 'local-tree-only'); assert.equal(result.storageVerification, 'adapter-reported-cid');
  assert.equal((await publishAllowlist(tree, { pin: async () => CID })).cid, CID);
  await assert.rejects(publishAllowlist(tree, { maxBytes: 1, pin: async () => { throw new Error('must not pin'); } }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(publishAllowlist(tree, { pin: async () => 'https://untrusted.example' }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(publishAllowlist(tree, { pin: async () => undefined }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(publishAllowlist({ ...tree, format: 'wrong' }, { pin: async () => CID }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(publishAllowlist(tree, { pin: undefined }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(publishAllowlist(tree, { timeoutMs: 5, pin: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(publishAllowlist(tree, { signal: AbortSignal.abort(), pin: async () => CID }), { code: 'ABORTED' });
});

test('Supabase bridge maps every change/reconnect/error and removes the channel exactly once', async () => {
  let event, status, removes = 0, subscribed;
  const channel = { on(type, filter, callback) { assert.equal(type, 'postgres_changes'); assert.deepEqual(filter, { event: '*', schema: 'testnet', table: 'ds_members', filter: `dao_id=eq.${DAO}` }); event = callback; return this; }, subscribe(callback) { status = callback; return this; } };
  const client = { channel(name) { subscribed = name; return channel; }, async removeChannel(value) { assert.equal(value, channel); removes++; return 'ok'; } };
  const events = [], errors = []; let reconnects = 0;
  const controller = new AbortController();
  const subscribe = supabaseRealtimeAdapter(client, { table: 'members', schema: 'testnet', channelName: 'my-feed', filter: { column: 'dao_id', value: DAO } });
  const unsubscribe = await subscribe({ onChange: value => events.push(value), onReconnect: () => { reconnects++; }, onReorg: () => {}, onError: error => errors.push(error) }, controller.signal);
  assert.equal(subscribed, 'my-feed');
  for (const eventType of ['INSERT', 'UPDATE', 'DELETE']) event({ schema: 'testnet', table: 'ds_members', eventType });
  status('SUBSCRIBED'); status('SUBSCRIBED'); status('CHANNEL_ERROR', new Error('offline')); status('TIMED_OUT'); status('CLOSED'); status('unexpected');
  assert.equal(events.length, 3); assert.equal(reconnects, 2); assert.equal(errors.length, 3);
  controller.abort(); await unsubscribe(); await unsubscribe(); assert.equal(removes, 1);
  event({ eventType: 'INSERT' }); status('SUBSCRIBED'); assert.equal(events.length, 3); assert.equal(reconnects, 2);
});

test('Supabase bridge rejects unsafe filters, surfaces removal failures and cleans setup failures', async () => {
  const client = { channel() { return { on() { return this; }, subscribe() { return this; } }; }, removeChannel: async () => 'ok' };
  for (const patch of [{ schema: 'bad;schema' }, { table: '__proto__' }, { channelName: 'space name' }, { filter: { column: 'or', value: 'x' } }, { filter: { column: 'config', value: '{}' } }, { filter: { column: 'dao_id', value: 'x),or(id.eq.x)' } }, { filter: { column: 'permission', value: '1' } }, { filter: { column: 'paused', value: 'true' } }]) assert.throws(() => supabaseRealtimeAdapter(client, { table: 'navigators', schema: 'testnet', ...patch }), { code: 'INVALID_ARGUMENT' });
  for (const [table, filter] of [['navigators', { column: 'permission', value: 1 }], ['navigators', { column: 'paused', value: false }], ['members', { column: 'shares', value: 1n }]]) {
    const release = await supabaseRealtimeAdapter(client, { table, schema: 'testnet', filter })({ onChange() {}, onReconnect() {}, onReorg() {}, onError() {} }, new AbortController().signal); await release();
  }
  assert.throws(() => supabaseRealtimeAdapter(client, { table: 'members', schema: 'testnet', filter: { column: 'shares', value: 1 } }), { code: 'INVALID_ARGUMENT' });
  const callbacks = { onChange() {}, onReconnect() {}, onReorg() {}, onError() {} };
  assert.throws(() => supabaseRealtimeAdapter(client, { table: 'records', schema: 'testnet' })(callbacks, AbortSignal.abort()), { code: 'ABORTED' });
  const release = await supabaseRealtimeAdapter({ ...client, removeChannel: async () => 'timed out' }, { table: 'records', schema: 'testnet' })(callbacks, new AbortController().signal);
  await assert.rejects(release(), { code: 'INDEXER_ERROR' });
  let removed = false;
  const broken = supabaseRealtimeAdapter({ channel: () => ({ on() { throw new Error('setup failed'); } }), removeChannel: async () => { removed = true; } }, { table: 'records', schema: 'testnet' });
  assert.throws(() => broken(callbacks, new AbortController().signal), /setup failed/);
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(removed, true);
});

test('data deadlines cancel streaming work and do not start adapters after immediate caller abort', async () => {
  let cancelled = false;
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, timeoutMs: 5, fetch: async () => new Response(new ReadableStream({ cancel() { cancelled = true; } })) }), { code: 'TIMEOUT' });
  assert.equal(cancelled, true);
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, readRoot: async () => { throw new Error('RPC unavailable'); } }), error => error.code === 'INDEXER_ERROR' && error.cause.message === 'RPC unavailable');
  const controller = new AbortController(); let reads = 0;
  const pending = fetchIpfsAllowlist({ ...ipfsOptions, signal: controller.signal, readRoot: async () => { reads++; return root; } });
  controller.abort(); await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(reads, 0);
  await assert.rejects(publishAllowlist(tree, { timeoutMs: 5, pin: async () => {
    // A synchronous adapter can delay timer delivery; elapsed time must still fail closed.
    const end = performance.now() + 10; while (performance.now() < end) {}
    return CID;
  } }), { code: 'TIMEOUT' });
  for (const patch of [{ maxBytes: 0 }, { timeoutMs: 0 }, { readRoot: undefined }]) await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, ...patch }), { code: 'INVALID_ARGUMENT' });
});

test('IPFS cleanup failures preserve the original HTTP, size and timeout failures', async () => {
  const failingCleanup = (emit = false) => new ReadableStream({ ...(emit ? { pull(controller) { controller.enqueue(new Uint8Array(20)); } } : {}), cancel() { throw new Error('cleanup failed'); } });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, fetch: async () => new Response(failingCleanup(), { status: 503 }) }), error => error.code === 'INDEXER_ERROR' && error.details.status === 503);
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, maxBytes: 10, fetch: async () => new Response(failingCleanup(), { headers: { 'content-length': '100' } }) }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, maxBytes: 10, fetch: async () => new Response(failingCleanup(true)) }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsAllowlist({ ...ipfsOptions, timeoutMs: 5, fetch: async () => new Response(failingCleanup()) }), { code: 'TIMEOUT' });
});

test('realtime setup/observer failures and non-progressing pages fail without bypassing cleanup', async () => {
  const indexer = indexerFor({});
  await assert.rejects(watchIndexer(indexer, 'records', { schema: 'testnet', query: { filters: { tag: () => 'bad' } }, subscribe: () => () => {}, onSnapshot: () => {} }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(watchIndexer(indexer, 'records', { schema: 'testnet', subscribe: () => undefined, onSnapshot: () => {} }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(watchIndexer(indexer, 'records', { schema: 'testnet', debounceMs: 1, subscribe: () => () => {}, onSnapshot: () => {} }), { code: 'INVALID_ARGUMENT' });
  let cleanup = 0;
  await assert.rejects(watchIndexer(indexer, 'records', { schema: 'testnet', subscribe: () => () => { cleanup++; }, onSnapshot: () => { throw new Error('observer broke'); }, onError: () => { throw new Error('error observer broke'); } }), { code: 'INDEXER_ERROR' });
  assert.equal(cleanup, 1);
  const row = fixture('members', { id: 'same', shares: '1' });
  await assert.rejects(watchIndexer(sdk(async () => Response.json([row])), 'members', { schema: 'testnet', subscribe: () => () => {}, onSnapshot: () => {} }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(new DaoShipsData(indexerFor({}, () => ({ ...state, last_block_hash: 'bad' }))).getDaoProfile(DAO, readOptions), { code: 'INVALID_RESPONSE' });
});

test('realtime closes after an observer deadline rather than accumulating overlapping deliveries', async () => {
  let callbacks, deliveries = 0, cleanup = 0, finish;
  const observer = new Promise(resolve => { finish = resolve; });
  const watch = await watchIndexer(indexerFor({}), 'records', {
    schema: 'testnet', timeoutMs: 30, debounceMs: 10,
    subscribe: value => { callbacks = value; return () => { cleanup++; }; },
    onSnapshot: () => { deliveries++; if (deliveries > 1) return observer; },
  });
  const pending = watch.refresh();
  callbacks.onReconnect();
  await assert.rejects(pending, { code: 'TIMEOUT' });
  for (let i = 0; i < 10; i++) callbacks.onReconnect();
  await assert.rejects(watch.refresh(), { code: 'ABORTED' });
  await watch.close();
  assert.equal(cleanup, 1); assert.equal(deliveries, 2); assert.equal(watch.lastError.code, 'TIMEOUT');
  finish();
});

test('joined profiles never choose arbitrary same-block metadata and preserve materialized DAO fields', async () => {
  const dao = fixture('daos', { id: DAO, avatar: NAV, deployer: USER, name: 'Current', description: null, avatar_img: null, profile_source: 'vault' });
  const first = fixture('records', { id: 'a-hash', dao_id: DAO, user_address: NAV, tag: 'daoships.dao.profile', trust_level: 'VERIFIED', block_number: '9007199254740993', created_at: '2026-09-09T00:00:00Z', content_json: { schemaVersion: '1.0', daoAddress: DAO, banner: 'https://example.test/first' } });
  const second = { ...first, id: 'z-hash', content_json: { ...first.content_json, banner: 'https://example.test/last' } };
  for (const records of [[first, second], [{ ...first, block_number: null }, second]]) {
    const result = await new DaoShipsData(indexerFor({ daos: [dao], records })).getDaoProfile(DAO, readOptions);
    assert.equal(result.complete, false); assert.equal(result.profile, null); assert.equal(result.profileAmbiguous, true);
    assert.equal(result.profileReason, 'ambiguous-record-order'); assert.equal(result.metadata.name, 'Current');
    assert.equal(Object.hasOwn(result.metadata, 'banner'), false);
  }
  const member = fixture('members', { id: `${DAO}-${USER}`, dao_id: DAO, member_address: USER });
  const profile = { ...first, user_address: USER, tag: 'daoships.member.profile', trust_level: 'MEMBER', content_json: { schemaVersion: '1.0', daoAddress: DAO, name: 'Crew' } };
  const ambiguousMember = await new DaoShipsData(indexerFor({ members: [member], records: [profile, { ...profile, id: 'other-hash' }] })).getMemberProfile(DAO, USER, readOptions);
  assert.equal(ambiguousMember.complete, false); assert.equal(ambiguousMember.profileReason, 'ambiguous-record-order');
  assert.equal(ambiguousMember.profile, null); assert.equal(ambiguousMember.member.id, member.id);

  let cappedReads = 0;
  const capped = sdk(async url => {
    if (url.pathname.endsWith('ds_indexer_state')) return Response.json([state]);
    if (url.pathname.endsWith('ds_daos')) return Response.json([dao]);
    cappedReads++;
    return Response.json(Number(url.searchParams.get('offset')) === 0 ? [first] : [second]);
  });
  assert.equal((await new DaoShipsData(capped).getDaoProfile(DAO, readOptions)).profileAmbiguous, true);
  assert.equal(cappedReads, 2);

  // Sort by the original SQL numeric block column, not timestamp or decimal
  // strings: neighboring blocks may share a timestamp and exceed JS precision.
  const client = sdk(async url => {
    if (url.pathname.endsWith('ds_indexer_state')) return Response.json([state]);
    if (url.pathname.endsWith('ds_daos')) return Response.json([dao]);
    assert.equal(url.searchParams.get('order'), 'block_number.desc,id.asc');
    assert.equal(url.searchParams.get('limit'), '2');
    assert.match(url.searchParams.get('select'), /block_number::text/);
    return Response.json([first, { ...second, block_number: '9007199254740992' }]);
  });
  const distinct = await new DaoShipsData(client).getDaoProfile(DAO, readOptions);
  assert.equal(distinct.complete, true); assert.equal(distinct.profileAmbiguous, false);
  assert.equal(distinct.profileReason, 'latest-record'); assert.equal(distinct.metadata.banner, 'https://example.test/first');
});

test('opt-in profile ordering uses actual event positions and conservatively preserves legacy ambiguity', async () => {
  const dao = fixture('daos', { id: DAO, avatar: NAV, deployer: USER, profile_source: 'vault' });
  const first = fixture('records', { id: 'hash-a', dao_id: DAO, user_address: NAV, tag: 'daoships.dao.profile', trust_level: 'VERIFIED', block_number: '100', transaction_index: 4, log_index: 12, content_json: { schemaVersion: '1.0', daoAddress: DAO, banner: 'https://example.test/new' } });
  const second = { ...first, id: 'hash-z', transaction_index: 3, log_index: 9 };
  let queried = false;
  const ordered = rows => sdk(async url => {
    if (url.pathname.endsWith('ds_indexer_state')) return Response.json([state]);
    if (url.pathname.endsWith('ds_daos')) return Response.json([dao]);
    queried = true;
    assert.match(url.searchParams.get('select'), /transaction_index,log_index/);
    assert.equal(url.searchParams.get('order'), 'block_number.desc.nullsfirst,transaction_index.desc.nullsfirst,log_index.desc.nullsfirst,id.asc');
    const offset = Number(url.searchParams.get('offset'));
    return Response.json(rows.slice(offset, offset + 1)); // server caps at one row
  });
  for (const rows of [[first, second], [first, { ...second, transaction_index: 4, log_index: 11 }], [first],
    [{ ...first, block_number: '101' }, { ...second, transaction_index: null, log_index: null }],
    [{ ...first, block_number: '101', transaction_index: null, log_index: null }, second],
  ]) {
    const result = await new DaoShipsData(ordered(rows), { recordOrdering: true }).getDaoProfile(DAO, readOptions);
    assert.equal(result.complete, true); assert.equal(result.profileAmbiguous, false); assert.equal(result.metadata.banner, 'https://example.test/new');
  }
  for (const rows of [
    [{ ...first, transaction_index: null, log_index: null }, second],
    [first, { ...second, transaction_index: null, log_index: null }],
    [first, { ...second, transaction_index: 4, log_index: 12 }],
    [{ ...first, block_number: null }, second],
  ]) {
    const result = await new DaoShipsData(ordered(rows), { recordOrdering: true }).getDaoProfile(DAO, readOptions);
    assert.equal(result.complete, false); assert.equal(result.profileAmbiguous, true); assert.equal(result.profile, null);
  }
  assert.equal(queried, true);
  assert.throws(() => new DaoShipsData(ordered([]), { recordOrdering: 'yes' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(new DaoShipsData(ordered([first, first]), { recordOrdering: true }).getDaoProfile(DAO, readOptions), { code: 'INVALID_RESPONSE' });
  const { transaction_index, log_index, ...legacy } = first;
  await assert.rejects(new DaoShipsData(ordered([legacy]), { recordOrdering: true }).getDaoProfile(DAO, readOptions), { code: 'INVALID_RESPONSE' });
  const compatible = sdk(async url => {
    assert.equal(url.searchParams.get('select').includes('transaction_index'), false);
    return Response.json(url.pathname.endsWith('ds_indexer_state') ? [state] : url.pathname.endsWith('ds_daos') ? [dao] : Number(url.searchParams.get('offset')) === 0 ? [legacy] : []);
  });
  assert.equal((await new DaoShipsData(compatible).getDaoProfile(DAO, readOptions)).complete, true);
});
