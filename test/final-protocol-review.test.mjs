import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { buildPosterContent, encodePosterPost, POSTER_TAGS, validatePosterContent } from '../dist/poster.js';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { resolveVaultModulePredecessor, VAULT_MODULE_SENTINEL } from '../dist/vault.js';
import { getNavigatorRequirements, NAVIGATOR_REQUIREMENTS } from '../dist/navigator-permissions.js';
import { NAVIGATOR_KINDS, NAVIGATOR_LIMITS } from '../dist/navigators.js';
import { ALLOWLIST_LIMITS } from '../dist/allowlist.js';
import { GOVERNANCE_CONFIG_TYPES, GOVERNANCE_LIMITS, TOKEN_MINT_CAPS, NAVIGATOR_PERMISSIONS, GOVERNANCE_ABI, encodeGovernanceConfig, decodeGovernanceConfig } from '../dist/governance.js';
const DAO = '0x0011111111111111111111111111111111111111';
const POSTER = '0x0022222222222222222222222222222222222222';
const invalid = { code: 'INVALID_ARGUMENT' };

test('DAO profile update distinguishes materialized field clearing from absence and preserves null in on-chain JSON', () => {
  const payload = { daoAddress: DAO, name: null, description: null, avatar: null };
  const serialized = buildPosterContent(POSTER_TAGS.DAO_PROFILE, payload);
  const decoded = JSON.parse(serialized);
  assert.deepEqual(decoded, { ...payload, schemaVersion: '1.0' });
  assert.equal(validatePosterContent(POSTER_TAGS.DAO_PROFILE, decoded).valid, true);
  const tx = encodePosterPost(POSTER, POSTER_TAGS.DAO_PROFILE, payload);
  const [wireContent] = new Interface(CONTRACT_ABIS.Poster).decodeFunctionData('post(string,string)', tx.data);
  assert.equal(wireContent, serialized);
  const unchanged = JSON.parse(buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress: DAO }));
  for (const field of ['name', 'description', 'avatar']) assert.equal(Object.hasOwn(unchanged, field), false);
});

test('clear semantics apply only to supported DAO update columns, keeping initial and member profiles strict', () => {
  const initial = { daoAddress: DAO, name: 'A DAO', description: 'Builders' };
  for (const field of ['name', 'description', 'avatar']) assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE_INITIAL, { ...initial, [field]: null }), invalid);
  for (const field of ['banner', 'theme', 'links', 'tags']) assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress: DAO, [field]: null }), invalid);
  assert.throws(() => buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, { daoAddress: DAO, name: null }), invalid);
  assert.throws(() => buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, { daoAddress: DAO, name: 'Member', avatar: null }), invalid);
});

test('member profiles require the DAO address used by indexer routing', () => {
  assert.throws(() => buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, { name: 'Member' }), invalid);
  assert.equal(validatePosterContent(POSTER_TAGS.MEMBER_PROFILE, { schemaVersion: '1.0', name: 'Member' }).valid, false);
  const content = buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, { daoAddress: DAO, name: 'Member', bio: 'Builder' });
  assert.equal(JSON.parse(content).daoAddress, DAO);
  assert.equal(validatePosterContent(POSTER_TAGS.MEMBER_PROFILE, JSON.parse(content)).valid, true);
});

const modules = Array.from({ length: 6 }, (_, i) => `0x00${BigInt(i + 20).toString(16).padStart(38, '0')}`);
const vaultInterface = new Interface(CONTRACT_ABIS.QuaiVault);
function moduleProvider(pages) {
  const calls = [];
  return { calls, async call(request) {
    assert.equal(request.to, POSTER);
    assert.equal(request.blockTag, 77);
    assert.equal(request.from, DAO);
    const [cursor, size] = vaultInterface.decodeFunctionData('getModulesPaginated', request.data);
    calls.push({ cursor, size });
    const result = typeof pages === 'function' ? pages(cursor, size, calls.length) : pages[cursor.toLowerCase()];
    assert.ok(result, `Unexpected cursor: ${cursor}`);
    return vaultInterface.encodeFunctionResult('getModulesPaginated', result);
  } };
}
const lookup = { blockTag: 77, from: DAO, pageSize: 2 };

test('vault module predecessor lookup handles head, page boundaries, middle and confirmed absence at one block', async () => {
  const pages = {
    [VAULT_MODULE_SENTINEL]: [[modules[0], modules[1]], modules[2]],
    [modules[1]]: [[modules[2], modules[3]], VAULT_MODULE_SENTINEL],
  };
  for (const [target, expected, expectedPages] of [[modules[0], VAULT_MODULE_SENTINEL, 1], [modules[1], modules[0], 1], [modules[2], modules[1], 2], [modules[3], modules[2], 2], [modules[4], null, 2]]) {
    const provider = moduleProvider(pages);
    assert.equal(await resolveVaultModulePredecessor(provider, POSTER, target, lookup), expected);
    assert.equal(provider.calls.length, expectedPages);
    assert.ok(provider.calls.every(c => c.size === 2n));
  }
  assert.equal(await resolveVaultModulePredecessor(moduleProvider({ [VAULT_MODULE_SENTINEL]: [[], VAULT_MODULE_SENTINEL] }), POSTER, modules[0], lookup), null);
});

test('vault module lookup rejects malformed pages and cycles even when a target occurs earlier in the same page', async () => {
  const badPages = [
    [[modules[0], modules[0]], VAULT_MODULE_SENTINEL],
    [[modules[0], VAULT_MODULE_SENTINEL], VAULT_MODULE_SENTINEL],
    [[modules[0], '0x' + '00'.repeat(20)], VAULT_MODULE_SENTINEL],
    [[modules[0], modules[1], modules[2]], VAULT_MODULE_SENTINEL],
    [[modules[0]], '0x' + '00'.repeat(20)],
    [[], modules[1]],
  ];
  for (const firstPage of badPages) await assert.rejects(resolveVaultModulePredecessor(moduleProvider({ [VAULT_MODULE_SENTINEL]: firstPage }), POSTER, modules[0], lookup), { code: 'INVALID_RESPONSE' });
  const repeated = moduleProvider({ [VAULT_MODULE_SENTINEL]: [[modules[0]], modules[0]] });
  await assert.rejects(resolveVaultModulePredecessor(repeated, POSTER, modules[5], lookup), { code: 'INVALID_RESPONSE' });
  const duplicateAcrossPages = moduleProvider({ [VAULT_MODULE_SENTINEL]: [[modules[0], modules[1]], modules[2]], [modules[1]]: [[modules[0]], VAULT_MODULE_SENTINEL] });
  await assert.rejects(resolveVaultModulePredecessor(duplicateAcrossPages, POSTER, modules[5], lookup), { code: 'INVALID_RESPONSE' });
});

test('vault module lookup bounds cannot turn incomplete traversal into false absence', async () => {
  const pages = { [VAULT_MODULE_SENTINEL]: [[modules[0], modules[1]], modules[2]], [modules[1]]: [[modules[2]], VAULT_MODULE_SENTINEL] };
  await assert.rejects(resolveVaultModulePredecessor(moduleProvider(pages), POSTER, modules[5], { ...lookup, maxPages: 1 }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(resolveVaultModulePredecessor(moduleProvider(pages), POSTER, modules[5], { ...lookup, maxModules: 2 }), { code: 'INVALID_RESPONSE' });
  const exact = moduleProvider({ [VAULT_MODULE_SENTINEL]: [[modules[0], modules[1]], VAULT_MODULE_SENTINEL] });
  assert.equal(await resolveVaultModulePredecessor(exact, POSTER, modules[5], { ...lookup, maxModules: 2 }), null);
});

test('vault predecessor resolution requires fixed block identity and rejects unusable input bounds', async () => {
  const untouched = { call() { throw Error('Must not call provider'); } };
  for (const patch of [{ blockTag: 'latest' }, { blockTag: 'pending' }, { blockTag: -1 }, { blockTag: undefined }, { maxPages: 0 }, { maxModules: Infinity }, { pageSize: 1001 }]) await assert.rejects(resolveVaultModulePredecessor(untouched, POSTER, modules[0], { ...lookup, ...patch }), invalid);
  await assert.rejects(resolveVaultModulePredecessor(untouched, POSTER, VAULT_MODULE_SENTINEL, lookup), invalid);
  await assert.rejects(resolveVaultModulePredecessor(untouched, '0x' + '00'.repeat(20), modules[0], lookup), invalid);
  const provider = { async call(request) {
    assert.equal(request.blockTag, '0x4d');
    return vaultInterface.encodeFunctionResult('getModulesPaginated', [[modules[0]], VAULT_MODULE_SENTINEL]);
  } };
  assert.equal(await resolveVaultModulePredecessor(provider, POSTER, modules[0], { blockTag: '0x4d' }), VAULT_MODULE_SENTINEL);
});

test('vault module lookup forwards bounded read cancellation and timeout options', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(resolveVaultModulePredecessor({ call() { throw Error('Must not call provider'); } }, POSTER, modules[0], { ...lookup, signal: controller.signal }), { code: 'ABORTED' });
  await assert.rejects(resolveVaultModulePredecessor({ call() { return new Promise(() => {}); } }, POSTER, modules[0], { ...lookup, timeoutMs: 5 }), { code: 'TIMEOUT' });
});

test('vault module lookup snapshots caller options before awaiting the first page', async () => {
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const provider = moduleProvider({ [VAULT_MODULE_SENTINEL]: [[modules[0], modules[1]], modules[2]], [modules[1]]: [[modules[2]], VAULT_MODULE_SENTINEL] });
  const gated = { async call(request) { if (provider.calls.length === 0) { entered(); await hold; } return provider.call(request); } };
  const options = { ...lookup, timeoutMs: 1000, maxPages: 3, maxModules: 10 };
  const pending = resolveVaultModulePredecessor(gated, POSTER, modules[2], options);
  await started;
  const controller = new AbortController(); controller.abort();
  Object.assign(options, { blockTag: 78, from: POSTER, timeoutMs: 1, maxPages: 1, maxModules: 1, pageSize: 1, signal: controller.signal, maxResponseBytes: 1 });
  release();
  assert.equal(await pending, modules[1]);
  assert.equal(provider.calls.length, 2);
});

test('navigator requirements distinguish DAO roles, vault permissions and indexed endorsement for all eight kinds', () => {
  assert.deepEqual(Object.keys(NAVIGATOR_REQUIREMENTS).sort(), [...NAVIGATOR_KINDS].sort());
  for (const kind of ['OnboarderNavigator', 'ERC20TributeNavigator', 'NFTGatedNavigator', 'VestingNavigator', 'SubscriptionNavigator']) assert.deepEqual(getNavigatorRequirements(kind), { daoPermission: 2n, vaultModule: false, posterEndorsement: false });
  assert.deepEqual(getNavigatorRequirements('TimelockNavigator'), { daoPermission: 4n, vaultModule: false, posterEndorsement: false });
  assert.deepEqual(getNavigatorRequirements('BudgetNavigator'), { daoPermission: 0n, vaultModule: true, posterEndorsement: false });
  assert.deepEqual(getNavigatorRequirements('SignalNavigator'), { daoPermission: 0n, vaultModule: false, posterEndorsement: true });
  for (const kind of ['__proto__', 'unknown', 'toString']) assert.throws(() => getNavigatorRequirements(kind), invalid);
  assert.throws(() => { getNavigatorRequirements('SignalNavigator').daoPermission = 7n; }, TypeError);
});

test('exported protocol definitions resist runtime mutation without changing governance encoding or Poster routing', () => {
  for (const definition of [POSTER_TAGS, ALLOWLIST_LIMITS, GOVERNANCE_CONFIG_TYPES, GOVERNANCE_LIMITS, TOKEN_MINT_CAPS, NAVIGATOR_PERMISSIONS, GOVERNANCE_ABI, NAVIGATOR_KINDS, NAVIGATOR_LIMITS]) {
    assert.equal(Object.isFrozen(definition), true);
    const key = Object.keys(definition)[0], original = definition[key];
    assert.throws(() => { definition[key] = 'corrupted'; }, TypeError);
    assert.equal(definition[key], original);
    assert.throws(() => { delete definition[key]; }, TypeError);
  }
  const config = { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 0 };
  assert.deepEqual(decodeGovernanceConfig(encodeGovernanceConfig(config)), config);
  assert.equal(POSTER_TAGS.DAO_PROFILE, 'daoships.dao.profile');
  assert.equal(JSON.parse(buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress: DAO, name: null })).name, null);
});

// Model the deployed Solidity algorithm: start is exclusive and next is unreturned.
test('vault pagination follows the actual linked list without skipping page boundaries', async () => {
  const provider = moduleProvider((cursor, size) => {
    const start = cursor === VAULT_MODULE_SENTINEL ? 0 : modules.indexOf(cursor) + 1;
    const end = start + Number(size);
    return [modules.slice(start, end), modules[end] ?? VAULT_MODULE_SENTINEL];
  });
  for (let i = 0; i < modules.length; i++) {
    assert.equal(await resolveVaultModulePredecessor(provider, POSTER, modules[i], lookup), modules[i - 1] ?? VAULT_MODULE_SENTINEL);
  }
  const corrupt = moduleProvider({ [VAULT_MODULE_SENTINEL]: [[modules[0], modules[1]], modules[2]], [modules[1]]: [[modules[3]], VAULT_MODULE_SENTINEL] });
  await assert.rejects(resolveVaultModulePredecessor(corrupt, POSTER, modules[3], lookup), { code: 'INVALID_RESPONSE' });
});
