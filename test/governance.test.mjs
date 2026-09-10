import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { AbiCoder, Interface } from 'quais';
import { GOVERNANCE_ABI, GOVERNANCE_CONFIG_TYPES, encodeGovernanceConfig, decodeGovernanceConfig, encodeGovernanceCall, buildGovernanceAction, governanceRequiresProposal } from '../dist/governance.js';
const A = '0x001117dd3c8574bc34227074472fb64349d2c3e9';
const cfg = { votingPeriod: 60, gracePeriod: 0, proposalOffering: 2n ** 200n, quorumPercent: 5000n, sponsorThreshold: 1n, minRetentionPercent: 10000n, defaultExpiryWindow: 0xffffffff };
const abi = new Interface(CONTRACT_ABIS.DAOShip);
test('governance config is the Solidity seven-field tuple with exact bigint values', () => {
  const encoded = encodeGovernanceConfig(cfg);
  assert.deepEqual(decodeGovernanceConfig(encoded), cfg);
  assert.deepEqual([...AbiCoder.defaultAbiCoder().decode(GOVERNANCE_CONFIG_TYPES, encoded)], [60n, 0n, cfg.proposalOffering, 5000n, 1n, 10000n, 0xffffffffn]);
  for (const patch of [{ votingPeriod: 59 }, { votingPeriod: 31536001 }, { votingPeriod: NaN }, { gracePeriod: 0.5 }, { gracePeriod: 31536001 }, { quorumPercent: 10001n }, { minRetentionPercent: -1n }, { sponsorThreshold: 1n << 256n }, { defaultExpiryWindow: 0x100000000 }]) assert.throws(() => encodeGovernanceConfig({ ...cfg, ...patch }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => decodeGovernanceConfig(encoded + '00'), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => decodeGovernanceConfig('0x'), { code: 'INVALID_ARGUMENT' });
});
test('every governance builder selector matches shipped contract ABI', () => {
  const local = new Interface(GOVERNANCE_ABI);
  local.forEachFunction(f => assert.equal(f.selector, abi.getFunction(f.name).selector));
  const calls = [
    ...['mintShares','mintLoot','burnShares','burnLoot'].map(method => ({ method, accounts: [A], amounts: [123n] })),
    { method: 'convertSharesToLoot', account: A, amount: 123n },
    { method: 'setAdminConfig', pauseShares: true, pauseLoot: false }, { method: 'setGovernanceConfig', config: cfg },
    { method: 'setNavigators', navigators: [A], permissions: [7n] }, { method: 'setGuildTokens', tokens: [A], enabled: [true] },
    ...['lockAdmin','lockManager','lockGovernor'].map(method => ({ method })),
  ];
  for (const call of calls) assert.equal(abi.parseTransaction({ data: encodeGovernanceCall(call) }).name, call.method);
  const wrapped = buildGovernanceAction(A, calls[0]);
  const decoded = abi.decodeFunctionData('executeAsGovernance', wrapped.data);
  assert.equal(decoded[0].toLowerCase(), A); assert.equal(decoded[1], 0n);
  assert.equal(decoded[2], encodeGovernanceCall(calls[0]));
});
test('governance-only calls cannot be bypassed with navigator roles', () => {
  for (const method of ['setNavigators', 'setGuildTokens', 'lockAdmin', 'lockManager', 'lockGovernor']) assert.equal(governanceRequiresProposal(method, 7n), true);
  assert.equal(governanceRequiresProposal('setGovernanceConfig', 4n), false);
  assert.equal(governanceRequiresProposal('setAdminConfig', 4n), true);
  assert.equal(governanceRequiresProposal('mintShares', 2n), false);
  assert.throws(() => encodeGovernanceCall({ method: 'mintShares', accounts: [], amounts: [] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeGovernanceCall({ method: 'setNavigators', navigators: [A], permissions: [8n] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeGovernanceCall({ method: 'setGuildTokens', tokens: [A], enabled: [] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeGovernanceCall({ method: 'setAdminConfig', pauseShares: 1, pauseLoot: false }), { code: 'INVALID_ARGUMENT' });
});
test('permission routing and bounds stay aligned with Solidity modifiers and constants', { skip: !existsSync(new URL('../../daoships-contracts/contracts/core/DAOShip.sol', import.meta.url)) }, () => {
  const source = readFileSync(new URL('../../daoships-contracts/contracts/core/DAOShip.sol', import.meta.url), 'utf8');
  for (const method of ['setNavigators', 'setGuildTokens', 'lockAdmin', 'lockManager', 'lockGovernor']) {
    assert.match(source, new RegExp(`function ${method}\\([^)]*\\) external governanceOnly`));
  }
  for (const [method, modifier] of [['mintShares','onlyManager'], ['convertSharesToLoot','onlyManager'], ['setAdminConfig','onlyAdmin'], ['setGovernanceConfig','onlyGovernor']]) {
    assert.match(source, new RegExp(`function ${method}\\([^)]*\\) external ${modifier}`));
  }
  assert.match(source, /MIN_VOTING_PERIOD = 60;/);
  assert.match(source, /MAX_VOTING_PERIOD = 31_536_000;/);
  assert.match(source, /MAX_GRACE_PERIOD = 31_536_000;/);
  assert.match(source, /MAX_NAVIGATORS_PER_CALL = 20;/);
  assert.match(source, /MAX_GUILD_TOKENS = 20;/);
});
