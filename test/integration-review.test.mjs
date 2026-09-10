import test from 'node:test';
import assert from 'node:assert/strict';
import { ZeroAddress } from 'quais';
import { encodeLaunchInitParams, decodeLaunchInitParams } from '../dist/launch.js';
import { quoteERC20Tribute } from '../dist/navigators.js';

const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const MAX_UINT = (1n << 256n) - 1n;
const SHARE_CAP = (1n << 216n) - 1n;
const LOOT_CAP = MAX_UINT / 2n;
const init = {
  multisendLibrary: A,
  governanceConfig: { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 0n, sponsorThreshold: 0n, minRetentionPercent: 0n, defaultExpiryWindow: 0 },
  navigators: [], navigatorPermissions: [], initMembers: [A], initShareAmounts: [1n], initLootAmounts: [1n],
  guildTokens: [], pauseSharesOnLaunch: false, pauseLootOnLaunch: false,
};

test('launch totals honor distinct SharesERC20 uint216 and LootERC20 uint256/2 mint caps', () => {
  assert.doesNotThrow(() => encodeLaunchInitParams({ ...init, initShareAmounts: [SHARE_CAP], initLootAmounts: [LOOT_CAP] }));
  for (const patch of [
    { initShareAmounts: [SHARE_CAP + 1n] },
    { initLootAmounts: [LOOT_CAP + 1n] },
    { initMembers: [A, B], initShareAmounts: [SHARE_CAP, 1n], initLootAmounts: [0n, 0n] },
    { initMembers: [A, B], initShareAmounts: [0n, 0n], initLootAmounts: [LOOT_CAP, 1n] },
  ]) assert.throws(() => encodeLaunchInitParams({ ...init, ...patch }), { code: 'INVALID_ARGUMENT' });
});

test('launch preserves zero-address skip semantics without allowing ABI overflows', () => {
  // DAOShip.setUp skips these entries before checking permissions or minting.
  const skipped = { ...init, navigators: [ZeroAddress], navigatorPermissions: [MAX_UINT], initMembers: [ZeroAddress, A], initShareAmounts: [MAX_UINT, 1n], initLootAmounts: [MAX_UINT, 1n] };
  const decoded = decodeLaunchInitParams(encodeLaunchInitParams(skipped));
  assert.deepEqual(decoded.navigatorPermissions, [MAX_UINT]);
  assert.deepEqual(decoded.initShareAmounts, [MAX_UINT, 1n]);
  assert.throws(() => encodeLaunchInitParams({ ...skipped, navigatorPermissions: [MAX_UINT + 1n] }), { code: 'INVALID_ARGUMENT' });
});

test('ERC20 tribute quotes reject summed mint overflow even when both tribute products fit', () => {
  // Both products and their divided tribute sum fit uint256; onboard's shares+loot does not.
  assert.throws(() => quoteERC20Tribute(MAX_UINT, MAX_UINT, 1n, 1n), { code: 'INVALID_ARGUMENT' });
  assert.equal(quoteERC20Tribute(10n ** 18n, 10n ** 18n, 1n, 1n), 2n);
});
