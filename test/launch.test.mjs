import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { AbiCoder, Interface, ZeroAddress, keccak256, solidityPacked, getCreate2Address } from 'quais';
import { encodeLaunchInitParams, decodeLaunchInitParams, encodeLaunchDAOShip, encodeLaunchDAOShipWithVault, encodeLaunchDAOShipAndVault } from '../dist/launch.js';
import { minimalProxyBytecode, minimalProxyInitCodeHash, packLaunchSalt, predictLaunchAddress, vaultInitCodeHash, mineLaunchSalt, mineDAOShipSalts, predictDAOShipAddresses, isCyprus1Address } from '../dist/launch-create2.js';
const A = '0x001117dd3c8574bc34227074472fb64349d2c3e9';
const B = '0x000f38dc0b711a57086ca0bd6fa2041d8cd9fe03';
const F = '0x005d0d996cb3f25bec37e1827feafce5ac9f7856';
const L = '0x0054cb24fa412b2b276d5f73f4a7adc70f0f0cbf';
const init = { multisendLibrary: A, governanceConfig: { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 0 }, navigators: [A], navigatorPermissions: [7n], initMembers: [A], initShareAmounts: [10n], initLootAmounts: [20n], guildTokens: [A, ZeroAddress, A], pauseSharesOnLaunch: true, pauseLootOnLaunch: false };
const params = { initialization: init, shareTokenName: 'Shares', shareTokenSymbol: 'S', lootTokenName: 'Loot', lootTokenSymbol: 'L', sharesSalt: 1n, lootSalt: 2n, daoShipSalt: 3n };
const combined = new Interface(CONTRACT_ABIS.DAOShipAndVaultLauncher);
const direct = new Interface(CONTRACT_ABIS.DAOShipLauncher);
test('launch preserves thirteen Solidity fields and supports unsorted duplicated guild tokens', () => {
  const data = encodeLaunchInitParams(init);
  const decoded = decodeLaunchInitParams(data);
  assert.equal(decoded.avatar, ZeroAddress); assert.equal(decoded.lootToken, ZeroAddress); assert.equal(decoded.sharesToken, ZeroAddress);
  assert.deepEqual(decoded.guildTokens.map(a => a.toLowerCase()), init.guildTokens);
  assert.deepEqual(decoded.governanceConfig, init.governanceConfig);
  assert.deepEqual(decoded.initShareAmounts, [10n]);
  assert.throws(() => encodeLaunchInitParams({ ...init, initLootAmounts: [] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeLaunchInitParams({ ...init, navigatorPermissions: [8n] }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => decodeLaunchInitParams(data + '00'), { code: 'INVALID_ARGUMENT' });
});
test('all three launch encoders match current launcher ABI and avatar semantics', () => {
  const d = direct.decodeFunctionData('launchDAOShip', encodeLaunchDAOShip({ ...params, existingVault: B }));
  assert.equal(decodeLaunchInitParams(d[0]).avatar.toLowerCase(), B);
  assert.deepEqual([...d].slice(5), [1n, 2n, 3n]);
  const e = combined.decodeFunctionData('launchDAOShipWithVault', encodeLaunchDAOShipWithVault({ ...params, existingVault: B }));
  assert.equal(e[5].toLowerCase(), B); assert.equal(decodeLaunchInitParams(e[0]).avatar, ZeroAddress);
  const n = combined.decodeFunctionData('launchDAOShipAndVault', encodeLaunchDAOShipAndVault({ ...params, vaultOwners: [A], vaultThreshold: 1n, vaultSalt: 4n }));
  assert.deepEqual([...n].slice(6), [1n, 4n, 1n, 2n, 3n]);
  assert.throws(() => encodeLaunchDAOShipAndVault({ ...params, vaultOwners: [A, A.toUpperCase().replace('0X','0x')], vaultThreshold: 1n, vaultSalt: 4n }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeLaunchDAOShip({ ...params, existingVault: ZeroAddress }), { code: 'INVALID_ARGUMENT' });
});
test('CREATE2 matches Solidity packed sender salt and standard ERC-1167 code', () => {
  const bytecode = `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${B.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  assert.equal(minimalProxyBytecode(B), bytecode);
  const salt = keccak256(solidityPacked(['address', 'uint256'], [L, 23n]));
  assert.equal(packLaunchSalt(L, 23n), salt);
  assert.equal(predictLaunchAddress(F, L, 23n, keccak256(bytecode)), getCreate2Address(F, salt, keccak256(bytecode)));
  assert.notEqual(packLaunchSalt(A, 23n), salt);
  assert.throws(() => predictLaunchAddress(F, L, 23n, '0x01'), { code: 'INVALID_ARGUMENT' });
});
test('vault init hash matches constructor encoding and canonical vault initialization ABI', () => {
  // Deliberately arbitrary creation bytes: the helper accepts caller-selected factory artifacts.
  const proxy = { bytecode: '0x600060005260206000f3' };
  const p = { proxyBytecode: proxy.bytecode, implementation: B, owners: [A], threshold: 1n, daoShip: L, multisendCallOnly: F };
  const data = new Interface(CONTRACT_ABIS.QuaiVault).encodeFunctionData('initialize', [[A], 1n, 0, [L], [F]]);
  const args = AbiCoder.defaultAbiCoder().encode(['address','bytes'], [B, data]);
  assert.equal(vaultInitCodeHash(p), keccak256(proxy.bytecode + args.slice(2)));
  assert.notEqual(vaultInitCodeHash({ ...p, daoShip: A }), vaultInitCodeHash(p));
});
test('salt mining is deterministic, bounded and cancelable mid-run', async () => {
  const options = { factory: F, sender: L, initCodeHash: minimalProxyInitCodeHash(B) };
  const first = await mineLaunchSalt(options), again = await mineLaunchSalt(options);
  assert.deepEqual(first, again); assert.equal(isCyprus1Address(first.address), true);
  assert.equal(predictLaunchAddress(F, L, first.salt, options.initCodeHash), first.address);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(mineLaunchSalt({ ...options, signal: controller.signal }), { code: 'ABORTED' });
  const during = new AbortController();
  // Choose a known nonmatching start so the first progress callback always runs.
  let startSalt = 0n; while (isCyprus1Address(predictLaunchAddress(F, L, startSalt, options.initCodeHash))) startSalt++;
  await assert.rejects(mineLaunchSalt({ ...options, startSalt, yieldEvery: 1, signal: during.signal, onProgress: () => during.abort() }), { code: 'ABORTED' });
  await assert.rejects(mineLaunchSalt({ ...options, startSalt, maxAttempts: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('multi-contract mining predicts clones before incorporating DAO module into vault hash', async () => {
  const vault = { factory: F, proxyBytecode: '0x60006000', implementation: B, owners: [A], threshold: 1n, multisendCallOnly: F };
  const singletons = { daoShip: B, shares: A, loot: L };
  const mined = await mineDAOShipSalts({ factory: F, sender: L, singletons, vault });
  const predicted = predictDAOShipAddresses({ factory: F, sender: L, singletons, sharesSalt: mined.shares.salt, lootSalt: mined.loot.salt, daoShipSalt: mined.daoShip.salt });
  assert.deepEqual(predicted, { daoShip: mined.daoShip.address, shares: mined.shares.address, loot: mined.loot.address });
  assert.equal(mined.vault.address, predictLaunchAddress(F, L, mined.vault.salt, vaultInitCodeHash({ ...vault, daoShip: mined.daoShip.address })));
});
test('initial mint caps and zero navigator skipping match token and DAO setup contracts', () => {
  const maxShares = (1n << 216n) - 1n, maxLoot = ((1n << 256n) - 1n) / 2n;
  assert.doesNotThrow(() => encodeLaunchInitParams({ ...init, initShareAmounts: [maxShares], initLootAmounts: [maxLoot], navigators: [ZeroAddress], navigatorPermissions: [255n] }));
  for (const patch of [{ initShareAmounts: [maxShares + 1n] }, { initLootAmounts: [maxLoot + 1n] }, { initMembers: [A, B], initShareAmounts: [maxShares, 1n], initLootAmounts: [0n, 0n] }]) {
    assert.throws(() => encodeLaunchInitParams({ ...init, ...patch }), { code: 'INVALID_ARGUMENT' });
  }
  assert.throws(() => encodeLaunchInitParams({ ...init, navigators: [ZeroAddress], navigatorPermissions: [1n << 256n] }), { code: 'INVALID_ARGUMENT' });
});

test('multi-phase mining captures factory, singleton and vault identities before progress yields', async () => {
  const vault = { factory: F, proxyBytecode: '0x60006000', implementation: B, owners: [A], threshold: 1n, multisendCallOnly: F };
  const singletons = { daoShip: B, shares: A, loot: L };
  const original = { factory: F, sender: L, singletons: { ...singletons }, vault: structuredClone(vault) };
  let changed = false;
  const options = { factory: F, sender: L, singletons, vault, yieldEvery: 1, onProgress() {
    if (changed) return;
    changed = true;
    options.sender = A; options.factory = B;
    singletons.loot = B; singletons.daoShip = A; vault.owners[0] = B; vault.threshold = 2n;
  } };
  const mined = await mineDAOShipSalts(options);
  assert.equal(changed, true);
  const expected = predictDAOShipAddresses({ ...original, sharesSalt: mined.shares.salt, lootSalt: mined.loot.salt, daoShipSalt: mined.daoShip.salt });
  assert.deepEqual(expected, { shares: mined.shares.address, loot: mined.loot.address, daoShip: mined.daoShip.address });
  assert.equal(mined.vault.address, predictLaunchAddress(F, L, mined.vault.salt, vaultInitCodeHash({ ...original.vault, daoShip: mined.daoShip.address })));
});
