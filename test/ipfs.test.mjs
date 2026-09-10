import test from 'node:test';
import assert from 'node:assert/strict';
import { Fragment, sha256, keccak256 } from 'quais';
import { resolveIpfsUrl, fetchIpfsJson, fetchIpfsAbi, fetchIpfsBytecode, fetchIpfsAllowlist, buildAllowlistTree, IPFS_GATEWAYS } from '../dist/index.js';

const CID = 'bafkreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ABI = [{ type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] }];
const options = value => ({ resource: CID, fetch: async () => Response.json(value) });

test('IPFS routing separates contract artifacts from all other content and validates immutable paths', () => {
  assert.equal(resolveIpfsUrl(CID), `https://ipfs.io/ipfs/${CID}`);
  assert.equal(resolveIpfsUrl(`ipfs://${CID}/metadata.json`, 'contract'), `https://ipfs.qu.ai/ipfs/${CID}/metadata.json`);
  assert.equal(resolveIpfsUrl(`ipfs://ipfs/${CID}/icon.svg`), `https://ipfs.io/ipfs/${CID}/icon.svg`);
  assert.equal(resolveIpfsUrl(CID, 'content', 'https://gateway.test/prefix/ipfs/'), `https://gateway.test/prefix/ipfs/${CID}`);
  assert.ok(Object.isFrozen(IPFS_GATEWAYS));
  for (const resource of [`${CID}/../secret`, `${CID}/%2e%2e/x`, `${CID}/%252e%252e/x`, `${CID}/a%2fb`, `${CID}/x?key=abc`, `${CID}/x#frag`, `${CID}/%00`, `${CID}/%ZZ`, `${CID}/`, `https://other.test/${CID}`, `ipns://${CID}`, 'x'.repeat(2049)]) {
    assert.throws(() => resolveIpfsUrl(resource), { code: 'INVALID_ARGUMENT' });
  }
  for (const purpose of ['constructor', 'unknown', ['content']]) assert.throws(() => resolveIpfsUrl(CID, purpose), { code: 'INVALID_ARGUMENT' });
  for (const gateway of ['invalid', 'file:///tmp', 'https://user:pass@host', 'https://host/?key=x', 'https://host/#x']) assert.throws(() => resolveIpfsUrl(CID, 'content', gateway), { code: 'INVALID_ARGUMENT' });
});

test('IPFS JSON sends no credentials, bounds bytes and distinguishes trusted hashes from gateway claims', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ name: 'DAO' }));
  const result = await fetchIpfsJson({ resource: CID, expectedSha256: sha256(bytes), fetch: async (url, request) => {
    assert.equal(url, `https://ipfs.io/ipfs/${CID}`);
    assert.equal(request.credentials, 'omit'); assert.equal(request.method, 'GET'); assert.equal(request.redirect, 'error');
    assert.equal(request.headers.Authorization, undefined); assert.equal(request.headers.apikey, undefined);
    return new Response(bytes);
  } });
  assert.deepEqual(result.value, { name: 'DAO' }); assert.equal(result.integrity, 'expected-sha256');
  assert.equal((await fetchIpfsJson(options({}))).integrity, 'unverified-gateway');
  await assert.rejects(fetchIpfsJson({ ...options({}), expectedSha256: `0x${'11'.repeat(32)}` }), { code: 'HASH_MISMATCH' });
  await assert.rejects(fetchIpfsJson({ ...options({}), expectedSha256: 'bad' }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(fetchIpfsJson({ ...options({}), maxBytes: 0 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(fetchIpfsJson({ ...options({}), fetch: 1 }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(fetchIpfsJson({ ...options({}), maxBytes: 1 }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsJson({ resource: CID, fetch: async () => new Response('bad json') }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsJson({ resource: CID, fetch: async () => new Response(new Uint8Array([255])) }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsJson({ resource: CID, timeoutMs: 5, fetch: () => new Promise(() => {}) }), { code: 'TIMEOUT' });
  await assert.rejects(fetchIpfsJson({ ...options({}), signal: AbortSignal.abort() }), { code: 'ABORTED' });
});

test('IPFS ABI accepts standalone/artifact/Solidity metadata formats through the contract gateway', async () => {
  for (const value of [ABI, { abi: ABI }, { output: { abi: ABI } }]) {
    const result = await fetchIpfsAbi({ resource: CID, fetch: async url => {
      assert.equal(new URL(url).hostname, 'ipfs.qu.ai'); return Response.json(value);
    } });
    assert.deepEqual(result.abi, ABI); assert.equal(result.integrity, 'unverified-gateway');
  }
  for (const value of [null, [], { output: 'wrong' }, ['function foo()'], [{ type: 'unknown' }], [{ type: 'function', name: 'x', inputs: [{ type: 'invalid' }] }], Array(2049).fill(ABI[0])]) {
    await assert.rejects(fetchIpfsAbi(options(value)), { code: 'INVALID_RESPONSE' });
  }
});

test('IPFS bytecode requires a trusted keccak256 hash before returning deployment bytes', async () => {
  const bytecode = '0x60006000', expectedKeccak256 = keccak256(bytecode);
  const result = await fetchIpfsBytecode({ resource: CID, expectedKeccak256, fetch: async url => {
    assert.equal(new URL(url).hostname, 'ipfs.qu.ai'); return new Response(`${bytecode}\n`);
  } });
  assert.equal(result.bytecode, bytecode); assert.equal(result.integrity, 'expected-keccak256');
  await assert.rejects(fetchIpfsBytecode({ resource: CID, expectedKeccak256: 'bad', fetch() { throw Error('Must not request'); } }), { code: 'INVALID_ARGUMENT' });
  for (const value of ['0x', '0x01']) await assert.rejects(fetchIpfsBytecode({ resource: CID, expectedKeccak256, fetch: async () => new Response(value) }), { code: 'HASH_MISMATCH' });
  await assert.rejects(fetchIpfsBytecode({ resource: CID, expectedKeccak256, fetch: async () => new Response('not hex') }), { code: 'INVALID_RESPONSE' });
});

test('ABI parsing remains inside the deadline and rejects deeply nested components/array types', async () => {
  let input = { type: 'uint256' };
  for (let i = 0; i < 40; i++) input = { type: 'tuple', components: [input] };
  await assert.rejects(fetchIpfsAbi(options([{ ...ABI[0], inputs: [input] }])), { code: 'INVALID_RESPONSE' });
  await assert.rejects(fetchIpfsAbi(options([{ ...ABI[0], inputs: [{ type: 'uint256' + '[]'.repeat(33) }] }])), { code: 'INVALID_RESPONSE' });
  const original = Fragment.from;
  Fragment.from = function(value) {
    const end = performance.now() + 10;
    while (performance.now() < end) { /* Adversarial synchronous parser delay. */ }
    return original.call(this, value);
  };
  try { await assert.rejects(fetchIpfsAbi({ ...options(ABI), timeoutMs: 5 }), { code: 'TIMEOUT' }); }
  finally { Fragment.from = original; }
});

test('allowlists default to ipfs.io while retaining independent on-chain Merkle-root verification', async () => {
  const account = '0x0011111111111111111111111111111111111111', tree = buildAllowlistTree([account]);
  const result = await fetchIpfsAllowlist({ cid: CID, account, readRoot: async () => tree.tree[0], fetch: async url => {
    assert.equal(new URL(url).hostname, 'ipfs.io'); return Response.json(tree);
  } });
  assert.equal(result.member, true); assert.equal(result.verifiedAgainst, 'caller-chain-root');
});
