import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, keccak256 } from 'quais';
import { ALLOWLIST_LIMITS, allowlistLeaf, buildAllowlistTree, validateAllowlistTree, getAllowlistProof, verifyAllowlistProof, verifyAllowlistRoot, parseAllowlistInput } from '../dist/allowlist.js';
import { buildPosterContent, validatePosterContent, POSTER_TAGS, MAX_POSTER_CONTENT_BYTES } from '../dist/poster.js';
import { Navigator, navigatorDeploymentArgs, quoteOnboarder, quoteERC20Tribute } from '../dist/navigators.js';
import { encodeGovernanceCall, governanceRequiresProposal, encodeGovernanceConfig, decodeGovernanceConfig } from '../dist/governance.js';
import { mineLaunchSalt, minimalProxyInitCodeHash, predictLaunchAddress, isCyprus1Address } from '../dist/launch-create2.js';
import { encodeLaunchInitParams, validateVaultOwners } from '../dist/launch.js';
const A = '0x0011111111111111111111111111111111111111', B = '0x0022222222222222222222222222222222222222';
const invalid = { code: 'INVALID_ARGUMENT' };

test('Merkle dump validation rejects duplicate members even with mathematically valid hashes', () => {
  const leaf = allowlistLeaf(A), root = keccak256(concat([leaf, leaf]));
  const forged = { format: 'standard-v1', leafEncoding: ['address'], tree: [root, leaf, leaf], values: [{ value: [A], treeIndex: 2 }, { value: [A], treeIndex: 1 }] };
  assert.throws(() => validateAllowlistTree(forged), invalid);
  assert.equal(verifyAllowlistRoot(forged, root), false);
});

test('Merkle limits reject oversized sparse containers before hashing and sparse proofs cannot omit siblings', () => {
  const accounts = new Array(ALLOWLIST_LIMITS.maxMembers + 1);
  assert.throws(() => buildAllowlistTree(accounts), invalid);
  assert.throws(() => validateAllowlistTree({ format: 'standard-v1', leafEncoding: ['address'], values: accounts, tree: new Array(accounts.length * 2 - 1) }), invalid);
  assert.equal(verifyAllowlistProof(allowlistLeaf(A), A, new Array(1)), false);
  assert.equal(verifyAllowlistProof(allowlistLeaf(A), A, new Array(ALLOWLIST_LIMITS.maxProofNodes + 1)), false);
  assert.throws(() => parseAllowlistInput(' '.repeat(ALLOWLIST_LIMITS.maxInputCharacters + 1)), invalid);
  assert.throws(() => parseAllowlistInput(null), invalid);
});

test('Merkle root, index, membership and proof corruption fail closed across uneven tree sizes', () => {
  for (const count of [1, 2, 3, 5, 8, 17]) {
    const addresses = Array.from({ length: count }, (_, i) => `0x00${(BigInt(i) + 10n).toString(16).padStart(38, '0')}`);
    const dump = buildAllowlistTree(addresses);
    for (const member of addresses) {
      const proof = getAllowlistProof(dump, member);
      assert.equal(verifyAllowlistProof(dump.tree[0], member, proof), true);
      assert.equal(verifyAllowlistProof(dump.tree[0], B, proof), false);
      assert.equal(verifyAllowlistProof(dump.tree[0], member, [...proof, allowlistLeaf(B)]), false);
    }
    for (const mutate of [d => { d.tree[0] = allowlistLeaf(B); }, d => { d.values[0].treeIndex = -1; }, d => { d.values[0].value = [B]; }, d => { d.leafEncoding = ['uint256']; }]) {
      const broken = structuredClone(dump); mutate(broken);
      assert.throws(() => validateAllowlistTree(broken), invalid);
    }
  }
});

test('Poster refuses accessors without running them, custom objects, hidden keys and blocked nested keys', () => {
  let invoked = false;
  const getter = { get name() { invoked = true; return 'Member'; } };
  assert.throws(() => buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, getter), invalid);
  assert.equal(validatePosterContent(POSTER_TAGS.MEMBER_PROFILE, getter).valid, false);
  assert.equal(invoked, false);
  const blocked = JSON.parse('{"daoAddress":"' + A + '","links":{"__proto__":"https://example.com"}}');
  for (const payload of [blocked, { daoAddress: A, links: new Date() }, { daoAddress: A, theme: { toJSON() { return {}; } } }, Object.defineProperty({ daoAddress: A }, 'name', { value: 'hidden', enumerable: false })]) {
    assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, payload), invalid);
  }
});

test('Poster rejects sparse arrays, nonfinite values, unsupported nested fields and malformed link hosts', () => {
  for (const payload of [{ daoAddress: A, tags: new Array(2) }, { daoAddress: A, chainId: Infinity }, { daoAddress: A, links: { site: 'https://[' } }, { daoAddress: A, links: { site: 'ipfs://' } }]) {
    assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, payload), invalid);
  }
  assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_NAVIGATORS, { daoAddress: A, navigators: [{ address: B, permissions: 7 }] }), invalid);
  assert.doesNotThrow(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress: A, links: { site: 'https://example.com' } }));
});

test('Poster resource limits precede bigint parsing and allowlist tree hashing', () => {
  const hugePoll = { schemaVersion: '1.0', daoAddress: A, navigatorAddress: B, pollId: '9'.repeat(MAX_POSTER_CONTENT_BYTES + 1), options: ['Yes', 'No'] };
  assert.equal(validatePosterContent(POSTER_TAGS.SIGNAL_POLL, hugePoll).valid, false);
  assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress: A, links: { large: 'https://example.com/' + 'x'.repeat(MAX_POSTER_CONTENT_BYTES) } }), invalid);
  assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, { daoAddress: A, tags: new Array(MAX_POSTER_CONTENT_BYTES + 1) }), invalid);
  const cyclic = { daoAddress: A }; cyclic.theme = cyclic;
  assert.throws(() => buildPosterContent(POSTER_TAGS.DAO_PROFILE, cyclic), invalid);
  assert.throws(() => buildPosterContent(POSTER_TAGS.SIGNAL_POLL, { ...hugePoll, pollId: 2n ** 256n }), invalid);
});

test('Poster poll uint256 boundaries and normalized control-only required fields are validated', () => {
  const p = { daoAddress: A, navigatorAddress: B, pollId: (2n ** 256n - 1n), options: ['Yes', 'No'] };
  assert.equal(JSON.parse(buildPosterContent(POSTER_TAGS.SIGNAL_POLL, p)).pollId, p.pollId.toString());
  for (const pollId of [-1n, 2n ** 256n, (2n ** 256n).toString(), '-1', 0.5]) assert.throws(() => buildPosterContent(POSTER_TAGS.SIGNAL_POLL, { ...p, pollId }), invalid);
  assert.throws(() => buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, { daoAddress: A, name: '\x00\x80' }), invalid);
  assert.equal(validatePosterContent(POSTER_TAGS.MEMBER_PROFILE, { daoAddress: A, schemaVersion: '1.0', name: '\x00\x80' }).valid, false);
  assert.equal(JSON.parse(buildPosterContent(POSTER_TAGS.MEMBER_PROFILE, { daoAddress: A, name: 'Member' }, { schemaVersion: '1.\x000' })).schemaVersion, '1.0');
});

test('navigator ABI normalization rejects sparse arrays, unknown or ambiguous methods and string booleans', async () => {
  const nav = new Navigator('OnboarderNavigator', A);
  for (const [method, args] of [['onboard(bytes32[])', [new Array(1)]], ['onboard', []], ['noSuchMethod', []]]) assert.throws(() => nav.encode(method, args), invalid);
  assert.throws(() => new Navigator('VestingNavigator', A).encode('createSchedule', [B, 1n, 0n, 0n, 1n, 'false']), invalid);
  assert.throws(() => new Navigator('SignalNavigator', A).encode('createPoll', ['Q', 2n, 2n ** 64n - 1n, 1n]), invalid);
  const read = new Navigator('SignalNavigator', A, { call() { throw new Error('Must not reach provider'); } });
  await assert.rejects(read.read('noSuchMethod', []), invalid);
  assert.throws(() => navigatorDeploymentArgs('BudgetNavigator', null), invalid);
  let accessed = false;
  assert.throws(() => navigatorDeploymentArgs('BudgetNavigator', { get daoShip() { accessed = true; return A; }, name: '', description: '' }), invalid);
  assert.equal(accessed, false);
});

test('navigator simulation sends the canonical sender, value and calldata without metadata fields', async () => {
  const nav = new Navigator('OnboarderNavigator', A, { async call(request) {
    assert.deepEqual(Object.keys(request).sort(), ['blockTag', 'data', 'from', 'to', 'value']);
    assert.equal(request.from, B); assert.equal(request.value, 25n); assert.equal(request.blockTag, 12); return '0x';
  } });
  const result = await nav.simulate('onboard()', [], B, 25n, 12);
  assert.equal(result.operation, 'onboard()');
});

test('onboarder quotes accept complete constructor configurations and reject omitted pricing fields', () => {
  const config = { daoShip: A, name: 'Membership', description: '', shareMultiplier: 0n, lootMultiplier: 0n, pricePerUnit: 10n, sharesPerUnit: 3n, lootPerUnit: 2n, minTribute: 0n };
  assert.deepEqual(quoteOnboarder(config, 25n), { shares: 6n, loot: 4n, cost: 20n, refund: 5n });
  const { sharesPerUnit, ...missing } = config;
  assert.throws(() => quoteOnboarder(missing, 25n), invalid);
  for (let value = 10n; value <= 210n; value += 7n) {
    const quote = quoteOnboarder(config, value);
    assert.equal(quote.shares, value / 10n * 3n);
    assert.equal(quote.loot, value / 10n * 2n);
    assert.equal(quote.cost + quote.refund, value);
    assert.ok(quote.refund < config.pricePerUnit);
  }
  assert.throws(() => quoteOnboarder({ ...config, sharesPerUnit: 2n ** 255n }, 20n), invalid);
  assert.throws(() => quoteERC20Tribute(2n ** 255n, 2n ** 255n, 1n, 1n), invalid);
});

test('governance rejects unknown discriminants and canonical decoding rejects dirty uint32 padding', () => {
  for (const method of ['__proto__', 'toString', 'unknown']) {
    assert.throws(() => encodeGovernanceCall({ method }), invalid);
    assert.throws(() => governanceRequiresProposal(method, 7n), invalid);
  }
  const cfg = { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 0 };
  const valid = encodeGovernanceConfig(cfg);
  assert.throws(() => decodeGovernanceConfig('0x01' + valid.slice(4)), invalid);
});

test('governance and launch reject sparse permission, flag, owner and mint arrays before encoding', () => {
  assert.throws(() => encodeGovernanceCall({ method: 'setGuildTokens', tokens: [A], enabled: new Array(1) }), invalid);
  assert.throws(() => encodeGovernanceCall({ method: 'mintShares', accounts: [A], amounts: new Array(1) }), invalid);
  assert.throws(() => encodeGovernanceCall({ method: 'setGuildTokens', tokens: null, enabled: [] }), invalid);
  assert.throws(() => encodeGovernanceCall(null), invalid);
  assert.throws(() => validateVaultOwners(new Array(1), 1n), invalid);
  const init = { multisendLibrary: A, governanceConfig: { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 0 }, navigators: [], navigatorPermissions: [], initMembers: [A], initShareAmounts: [1n], initLootAmounts: [0n], guildTokens: [], pauseSharesOnLaunch: false, pauseLootOnLaunch: false };
  for (const patch of [{ initShareAmounts: new Array(1) }, { navigators: new Array(1), navigatorPermissions: [0n] }, { guildTokens: new Array(10001) }]) assert.throws(() => encodeLaunchInitParams({ ...init, ...patch }), invalid);
});

test('salt mining validates invalid scheduling bounds and uint256 range exhaustion', async () => {
  const options = { factory: A, sender: B, initCodeHash: minimalProxyInitCodeHash(A) };
  for (const patch of [{ maxAttempts: 0 }, { yieldEvery: 0 }, { maxAttempts: Infinity }, { startSalt: -1n }]) await assert.rejects(mineLaunchSalt({ ...options, ...patch }), invalid);
  const max = 2n ** 256n - 1n;
  if (!isCyprus1Address(predictLaunchAddress(A, B, max, options.initCodeHash))) await assert.rejects(mineLaunchSalt({ ...options, startSalt: max, maxAttempts: 2 }), invalid);
});

test('salt mining still yields to AbortSignal when progress callbacks are requested very infrequently', async () => {
  const options = { factory: A, sender: B, initCodeHash: minimalProxyInitCodeHash(A) };
  let startSalt = 0n, consecutive = 0;
  for (let salt = 0n; consecutive < 128; salt++) {
    if (isCyprus1Address(predictLaunchAddress(A, B, salt, options.initCodeHash))) { consecutive = 0; startSalt = salt + 1n; }
    else consecutive++;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 0);
  try { await assert.rejects(mineLaunchSalt({ ...options, startSalt, yieldEvery: Number.MAX_SAFE_INTEGER, signal: controller.signal }), { code: 'ABORTED' }); }
  finally { clearTimeout(timer); }
});
