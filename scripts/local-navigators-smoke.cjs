/* Local EVM integration: SDK bundled bytecodes, typed calls and real DAO/token state.
 * Uses the existing sibling Hardhat artifacts; does not compile or use any network RPC.
 * MockAvatar stands in for production QuaiVault authorization. */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const contractsRoot = path.resolve(__dirname, '../../daoships-contracts');
process.env.HARDHAT_CONFIG = path.join(__dirname, 'local-hardhat.config.cjs');
process.env.HARDHAT_NETWORK = 'hardhat';
const fromContracts = createRequire(path.join(contractsRoot, 'package.json'));

async function main() {
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../dist/index.js')).href);
  const { NAVIGATOR_BYTECODES } = await import(pathToFileURL(path.resolve(__dirname, '../dist/navigator-bytecodes.js')).href);
  const hre = fromContracts('hardhat');
  assert.equal(hre.network.name, 'hardhat');
  const { ethers } = hre;
  const [owner, member, outsider, recipient] = await ethers.getSigners();
  const checked = new Set();
  async function artifact(name) {
    const a = await hre.artifacts.readArtifact(name);
    const b = await hre.artifacts.getBuildInfo(`${a.sourceName}:${a.contractName}`);
    assert.ok(b, `Missing build info: ${name}`);
    const c = b.output.contracts[a.sourceName][name];
    for (const source of Object.keys(JSON.parse(c.metadata).sources)) {
      const key = `${b.id}:${source}`;
      if (checked.has(key)) continue;
      const file = path.join(contractsRoot, source.startsWith('@') ? 'node_modules' : '', source);
      assert.equal(fs.readFileSync(file, 'utf8'), b.input.sources[source].content, `Stale artifact: ${source}`);
      checked.add(key);
    }
    assert.equal(a.bytecode.slice(2), c.evm.bytecode.object);
    return a;
  }
  async function deploy(name, args = []) {
    const a = await artifact(name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment(); return c;
  }
  async function clone(name) {
    const implementation = await deploy(name);
    const raw = await new ethers.ContractFactory([], sdk.minimalProxyBytecode(await implementation.getAddress()), owner).deploy();
    await raw.waitForDeployment();
    return ethers.getContractAt(name, await raw.getAddress());
  }
  const dao = await clone('DAOShip'), shares = await clone('SharesERC20'), loot = await clone('LootERC20');
  const avatar = await deploy('MockAvatar'), multisend = await deploy('MultiSendCallOnly');
  const token = await deploy('MockERC20', ['Tribute', 'TRB']), nft = await deploy('MockERC721');
  const daoAddress = await dao.getAddress(), avatarAddress = await avatar.getAddress();
  await (await shares.initialize(daoAddress, 'Shares', 'SH')).wait();
  await (await loot.initialize(daoAddress, 'Loot', 'LT')).wait();
  await (await avatar.enableModule(daoAddress)).wait();
  await (await avatar.enableModule(owner.address)).wait();
  const base = { daoShip: daoAddress, name: 'SDK integration', description: 'Local lifecycle' };
  const capped = { expiry: 0n, mintCap: 10000n, perAddressCap: 1000n, allowlistRoot: ethers.ZeroHash };
  const configs = {
    OnboarderNavigator: { ...base, ...capped, shareMultiplier: 0n, lootMultiplier: 0n, pricePerUnit: 10n, sharesPerUnit: 3n, lootPerUnit: 2n, minTribute: 0n },
    ERC20TributeNavigator: { ...base, ...capped, tributeToken: await token.getAddress(), pricePerShare: 10n ** 18n, pricePerLoot: 2n * 10n ** 18n },
    NFTGatedNavigator: { ...base, ...capped, gateToken: await nft.getAddress(), sharesPerHolder: 7n, lootPerHolder: 3n, requireTribute: false, tributeAmount: 0n },
    SignalNavigator: { ...base, minSharesToCreatePoll: 1n, minDuration: 60n, maxDuration: 3600n, maxStartDelay: 3600n },
    TimelockNavigator: { ...base, delay: 600n, expiryWindow: 3600n },
    VestingNavigator: base,
    BudgetNavigator: base,
    SubscriptionNavigator: { ...base, tokens: [ethers.ZeroAddress, await token.getAddress()], feesPerPeriod: [10n, 20n], periodDuration: 3600n, graceDuration: 60n, startTime: 0n, collectorRewardBps: 0n, burnOnCollect: true, initialMembers: [member.address] },
  };
  const navs = {};
  async function deployNavigator(kind, config) {
    const a = await artifact(kind);
    assert.equal(NAVIGATOR_BYTECODES[kind], a.bytecode, `${kind} bundled bytecode parity`);
    const receipt = await (await owner.sendTransaction({ data: sdk.encodeNavigatorDeployment(kind, NAVIGATOR_BYTECODES[kind], config) })).wait();
    assert.ok(receipt.contractAddress);
    sdk.parseNavigatorDeploymentReceipt(receipt, receipt.contractAddress, { daoShip: daoAddress, deployer: owner.address, kind });
    const nav = new sdk.Navigator(kind, receipt.contractAddress, { call: request => ethers.provider.call(request) });
    assert.equal(await nav.read('navigatorType', []), kind);
    return nav;
  }
  for (const kind of sdk.NAVIGATOR_KINDS) {
    navs[kind] = await deployNavigator(kind, configs[kind]);
  }
  const governanceConfig = { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 1000n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 600 };
  const managers = ['OnboarderNavigator', 'ERC20TributeNavigator', 'NFTGatedNavigator', 'VestingNavigator', 'SubscriptionNavigator'];
  const init = sdk.encodeLaunchInitParams({
    multisendLibrary: await multisend.getAddress(), governanceConfig,
    navigators: [...managers.map(k => navs[k].address), navs.TimelockNavigator.address], navigatorPermissions: [2n, 2n, 2n, 2n, 2n, 4n],
    initMembers: [owner.address, member.address], initShareAmounts: [1000n, 100n], initLootAmounts: [0n, 0n],
    guildTokens: [ethers.ZeroAddress, await token.getAddress()], pauseSharesOnLaunch: false, pauseLootOnLaunch: false,
  }, avatarAddress);
  const fields = ethers.AbiCoder.defaultAbiCoder().decode(sdk.INIT_PARAMS_TYPES, init).toArray();
  fields[0] = await loot.getAddress(); fields[1] = await shares.getAddress();
  await (await dao.setUp(ethers.AbiCoder.defaultAbiCoder().encode(sdk.INIT_PARAMS_TYPES, fields))).wait();
  await (await owner.sendTransaction({ to: avatarAddress, value: 100000n })).wait();
  const send = async (nav, method, args, signer = member, value = 0n) => (await signer.sendTransaction(nav.encode(method, args, value))).wait();
  const throughAvatar = async (call) => {
    const args = [call.to, call.value, call.data, 0];
    const [success, returnData] = await avatar.execTransactionFromModuleReturnData.staticCall(...args);
    assert.ok(success, `Avatar call reverted: ${returnData}`);
    await (await avatar.execTransactionFromModuleReturnData(...args)).wait();
  };
  const advance = async seconds => { await hre.network.provider.send('evm_increaseTime', [seconds]); await hre.network.provider.send('evm_mine'); };
  const grantManager = async navigator => {
    const action = sdk.buildGovernanceAction(daoAddress, { method: 'setNavigators', navigators: [navigator.address], permissions: [2n] });
    const directAttempt = await avatar.execTransactionFromModuleReturnData.staticCall(action.to, action.value, action.data, 0);
    assert.equal(directAttempt[0], false, 'Even the avatar cannot grant roles outside proposal execution');
    const proposal = sdk.encodeProposal([action]);
    const client = new sdk.ContractClient('DAOShip', daoAddress);
    const submitted = await (await owner.sendTransaction(client.encode('submitProposal', [proposal, 0n, 'Enable SDK navigator']))).wait();
    const proposalId = sdk.parseSubmitReceipt(submitted, daoAddress);
    await (await owner.sendTransaction(client.encode('submitVote', [BigInt(proposalId), true]))).wait();
    await advance(Number(await dao.votingPeriod()) + 1);
    const processed = await (await owner.sendTransaction({ ...client.encode('processProposal', [BigInt(proposalId), proposal]), gasLimit: 1_000_000n })).wait();
    sdk.assertActionSucceeded(processed, daoAddress, proposalId);
  };

  const on = navs.OnboarderNavigator;
  const treasuryBefore = await ethers.provider.getBalance(avatarAddress);
  const quoted = sdk.quoteOnboarder(configs.OnboarderNavigator, 25n);
  await send(on, 'onboard()', [], member, 25n);
  assert.equal(await shares.balanceOf(member.address), 100n + quoted.shares);
  assert.equal(await loot.balanceOf(member.address), quoted.loot);
  assert.equal(await ethers.provider.getBalance(avatarAddress), treasuryBefore + quoted.cost);
  await assert.rejects(send(on, 'onboard()', [], member, 9n));
  await throughAvatar(on.encode('pause', []));
  await assert.rejects(send(on, 'onboard()', [], member, 10n));
  await throughAvatar(on.encode('unpause', []));

  const tribute = navs.ERC20TributeNavigator;
  await (await token.mint(member.address, 1000n)).wait();
  await (await token.connect(member).approve(tribute.address, 1000n)).wait();
  const tributeCost = sdk.quoteERC20Tribute(5n, 2n, configs.ERC20TributeNavigator.pricePerShare, configs.ERC20TributeNavigator.pricePerLoot);
  await send(tribute, 'onboard(uint256,uint256)', [5n, 2n]);
  assert.equal(await token.balanceOf(avatarAddress), tributeCost);
  assert.equal(await shares.balanceOf(member.address), 111n);

  const gate = navs.NFTGatedNavigator;
  await (await nft.mint(member.address, 1n)).wait();
  await assert.rejects(send(gate, 'onboard(uint256)', [1n], outsider));
  await send(gate, 'onboard(uint256)', [1n]);
  assert.equal(await shares.balanceOf(member.address), 118n);
  await assert.rejects(send(gate, 'onboard(uint256)', [1n]));

  const signal = navs.SignalNavigator;
  await advance(2);
  await assert.rejects(send(signal, 'createPoll', ['Question', 2n, 0n, 60n], outsider));
  await send(signal, 'createPoll', ['Question', 2n, 0n, 60n]);
  await send(signal, 'vote', [0n, 1n]);
  assert.deepEqual([...await signal.read('getResults', [0n])], [0n, 118n]);
  await assert.rejects(send(signal, 'vote', [0n, 0n]));
  await advance(61);
  assert.equal(await signal.read('pollStatus', [0n]), BigInt(sdk.SignalPollStatus.Ended));
  await assert.rejects(send(signal, 'vote', [0n, 0n], owner));

  const timelock = navs.TimelockNavigator;
  const changed = sdk.encodeGovernanceConfig({ ...governanceConfig, votingPeriod: 120 });
  await assert.rejects(send(timelock, 'queueChange', [changed]));
  await throughAvatar(timelock.encode('queueChange', [changed]));
  await assert.rejects(send(timelock, 'executeChange', [0n, changed], outsider));
  await advance(601);
  await assert.rejects(send(timelock, 'executeChange', [0n, sdk.encodeGovernanceConfig(governanceConfig)], outsider));
  await send(timelock, 'executeChange', [0n, changed], outsider);
  assert.equal(await dao.votingPeriod(), 120n);
  await assert.rejects(send(timelock, 'executeChange', [0n, changed], outsider));

  const vesting = navs.VestingNavigator;
  await assert.rejects(send(vesting, 'createSchedule', [recipient.address, 60n, 0n, 10n, 60n, false]));
  await throughAvatar(vesting.encode('createSchedule', [recipient.address, 60n, 0n, 10n, 60n, false]));
  await assert.rejects(send(vesting, 'claim', [0n], recipient));
  await advance(61);
  await assert.rejects(send(vesting, 'claim', [0n], outsider));
  await send(vesting, 'claim', [0n], recipient);
  assert.equal(await shares.balanceOf(recipient.address), 60n);
  await assert.rejects(send(vesting, 'claim', [0n], recipient));

  const budget = navs.BudgetNavigator;
  await throughAvatar(budget.encode('createBudget', [member.address, ethers.ZeroAddress, 100n, 200n, 3600n, 0n, 0n]));
  await assert.rejects(send(budget, 'disburse', [0n, recipient.address, 40n]));
  assert.equal(await budget.read('remainingTotal', [0n]), 200n);
  await (await avatar.enableModule(budget.address)).wait();
  await assert.rejects(send(budget, 'disburse', [0n, recipient.address, 40n], outsider));
  const recipientBefore = await ethers.provider.getBalance(recipient.address);
  await send(budget, 'disburse', [0n, recipient.address, 40n]);
  assert.equal(await ethers.provider.getBalance(recipient.address), recipientBefore + 40n);
  assert.equal(await budget.read('remainingThisPeriod', [0n]), 60n);
  await assert.rejects(send(budget, 'disburse', [0n, recipient.address, 61n]));
  await throughAvatar(budget.encode('cancelBudget', [0n]));
  await assert.rejects(send(budget, 'disburse', [0n, recipient.address, 1n]));

  const subscription = navs.SubscriptionNavigator;
  const paidBefore = await subscription.read('paidThrough', [member.address]);
  await assert.rejects(send(subscription, 'payFee', [1n, ethers.ZeroAddress], member, 9n));
  await send(subscription, 'payFee', [1n, ethers.ZeroAddress], member, 10n);
  assert.equal(await subscription.read('paidThrough', [member.address]), paidBefore + 3600n);
  await (await token.connect(member).approve(subscription.address, 100n)).wait();
  await send(subscription, 'payFee', [1n, await token.getAddress()]);
  assert.equal(await subscription.read('paidThrough', [member.address]), paidBefore + 7200n);
  assert.equal(await token.balanceOf(avatarAddress), tributeCost + 20n);
  await assert.rejects(send(subscription, 'collectFee', [member.address], outsider));
  await advance(12000);
  assert.equal(await subscription.read('isDelinquent', [member.address]), true);
  await send(subscription, 'collectFee', [member.address], outsider);
  assert.equal(await shares.balanceOf(member.address), 0n);
  assert.equal(await loot.balanceOf(member.address), 9n);
  await assert.rejects(send(subscription, 'collectFee', [member.address], outsider));

  // A real Cyprus-1-shaped EOA lets SDK-produced Merkle proofs cross the Solidity boundary.
  // Local impersonation supplies that account; this is not evidence of Quai shard routing.
  const allowedAddress = '0x0011111111111111111111111111111111111111';
  const otherAllowedAddress = '0x0022222222222222222222222222222222222222';
  await hre.network.provider.send('hardhat_setBalance', [allowedAddress, '0x56bc75e2d63100000']);
  const allowedSigner = await ethers.getImpersonatedSigner(allowedAddress);
  const tree = sdk.buildAllowlistTree([allowedAddress, otherAllowedAddress]);
  const multiplierConfig = { ...configs.OnboarderNavigator, shareMultiplier: 20000n, lootMultiplier: 10000n, pricePerUnit: 0n, sharesPerUnit: 0n, lootPerUnit: 0n, minTribute: 10n, allowlistRoot: tree.tree[0] };
  const multiplier = await deployNavigator('OnboarderNavigator', multiplierConfig);
  await grantManager(multiplier);
  const proof = sdk.getAllowlistProof(tree, allowedAddress);
  await assert.rejects(send(multiplier, 'onboard(bytes32[])', [proof], outsider, 10n));
  await assert.rejects(send(multiplier, 'onboard()', [], allowedSigner, 10n));
  await assert.rejects(send(multiplier, 'onboard(bytes32[])', [[ethers.ZeroHash]], allowedSigner, 10n));
  const multiplierQuote = sdk.quoteOnboarder(multiplierConfig, 10n);
  await send(multiplier, 'onboard(bytes32[])', [proof], allowedSigner, 10n);
  assert.equal(await shares.balanceOf(allowedAddress), multiplierQuote.shares);
  assert.equal(await loot.balanceOf(allowedAddress), multiplierQuote.loot);

  // Real ERC-2612 typed-data signature, no pre-existing allowance, then replay rejection.
  const permitToken = await deploy('MockERC20Permit', ['Permit Tribute', 'PT']);
  const permitTribute = await deployNavigator('ERC20TributeNavigator', { ...configs.ERC20TributeNavigator, tributeToken: await permitToken.getAddress() });
  await grantManager(permitTribute);
  await (await permitToken.mint(member.address, 100n)).wait();
  const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp + 3600);
  const permitProbe = await sdk.probeTokenPermit({ call: request => ethers.provider.call(request), getNetwork: () => ethers.provider.getNetwork() },
    await permitToken.getAddress(), member.address, { chainId: (await ethers.provider.getNetwork()).chainId, blockTag: await ethers.provider.getBlockNumber() });
  assert.equal(permitProbe.supported, true);
  const typedPermit = sdk.buildExternalPermitTypedData(permitProbe, { spender: permitTribute.address, value: 6n, deadline });
  const signature = ethers.Signature.from(await member.signTypedData(typedPermit.domain, typedPermit.types, typedPermit.value));
  const permitArgs = [4n, 1n, [], deadline, BigInt(signature.v), signature.r, signature.s];
  assert.equal(await permitToken.allowance(member.address, permitTribute.address), 0n);
  await send(permitTribute, 'onboardWithPermit', permitArgs);
  assert.equal(await permitToken.balanceOf(avatarAddress), 6n);
  assert.equal(await permitToken.nonces(member.address), 1n);
  assert.equal(await shares.balanceOf(member.address), 4n);
  assert.equal(await permitToken.allowance(member.address, permitTribute.address), 0n);
  await assert.rejects(send(permitTribute, 'onboardWithPermit', permitArgs));
  // Explicit allowance fallback uses exact approvals, zero-reset and revocation.
  await (await permitToken.connect(member).approve(permitTribute.address, 1n)).wait();
  const approvalPlan = await sdk.readTokenApprovalPlan({ call: request => ethers.provider.call(request) },
    { token: await permitToken.getAddress(), owner: member.address, spender: permitTribute.address, requiredAllowance: 7n });
  assert.equal(approvalPlan.steps.length, 2);
  for (const call of approvalPlan.steps) await (await member.sendTransaction(call)).wait();
  assert.equal(await permitToken.allowance(member.address, permitTribute.address), 7n);
  await (await member.sendTransaction(approvalPlan.revoke)).wait();
  assert.equal(await permitToken.allowance(member.address, permitTribute.address), 0n);

  // Conversion mode preserves a delinquent member's economic loot and pays the collector.
  const conversion = await deployNavigator('SubscriptionNavigator', { ...configs.SubscriptionNavigator, collectorRewardBps: 1000n, burnOnCollect: false, initialMembers: [recipient.address] });
  await grantManager(conversion);
  await throughAvatar(conversion.encode('pause', []));
  await assert.rejects(send(conversion, 'payFee', [1n, ethers.ZeroAddress], recipient, 10n));
  await throughAvatar(conversion.encode('unpause', []));
  const recipientShares = await shares.balanceOf(recipient.address);
  const recipientLoot = await loot.balanceOf(recipient.address), collectorLoot = await loot.balanceOf(outsider.address);
  await advance(3700);
  await send(conversion, 'collectFee', [recipient.address], outsider);
  assert.equal(await shares.balanceOf(recipient.address), 0n);
  assert.equal(await loot.balanceOf(recipient.address), recipientLoot + recipientShares);
  assert.equal(await loot.balanceOf(outsider.address), collectorLoot + recipientShares / 10n);
  assert.equal(await conversion.read('isEnrolled', [recipient.address]), false);
  await throughAvatar(conversion.encode('enrollBatch', [[recipient.address, recipient.address]]));
  assert.equal(await conversion.read('isCurrent', [recipient.address]), true);

  // Revocation freezes partial loot vesting; paused creation does not block earned claims.
  await throughAvatar(vesting.encode('createSchedule', [recipient.address, 100n, 0n, 0n, 100n, true]));
  await advance(30);
  await throughAvatar(vesting.encode('revoke', [1n]));
  const frozenClaim = await vesting.read('claimable', [1n]);
  assert.ok(frozenClaim > 0n && frozenClaim < 100n);
  await throughAvatar(vesting.encode('pause', []));
  await advance(150);
  assert.equal(await vesting.read('claimable', [1n]), frozenClaim);
  const beforePartialClaim = await loot.balanceOf(recipient.address);
  await send(vesting, 'claim', [1n], recipient);
  assert.equal(await loot.balanceOf(recipient.address), beforePartialClaim + frozenClaim);
  const revokedAgain = await avatar.execTransactionFromModuleReturnData.staticCall(vesting.address, 0n, vesting.encode('revoke', [1n]).data, 0);
  assert.equal(revokedAgain[0], false);

  // A cancelled timelock cannot execute after its delay even with the original bytes.
  await throughAvatar(timelock.encode('queueChange', [changed]));
  await throughAvatar(timelock.encode('cancelChange', [1n]));
  await advance(601);
  await assert.rejects(send(timelock, 'executeChange', [1n, changed], outsider));

  // ERC20 batch spending rolls its periodic allowance forward but retains the total ceiling.
  await (await token.mint(avatarAddress, 1000n)).wait();
  await throughAvatar(budget.encode('createBudget', [member.address, await token.getAddress(), 100n, 150n, 3600n, 0n, 0n]));
  const budgetRecipientBefore = await token.balanceOf(recipient.address), budgetOutsiderBefore = await token.balanceOf(outsider.address);
  await send(budget, 'disburseBatch', [1n, [recipient.address, outsider.address], [40n, 60n]]);
  assert.equal(await token.balanceOf(recipient.address), budgetRecipientBefore + 40n);
  assert.equal(await token.balanceOf(outsider.address), budgetOutsiderBefore + 60n);
  await assert.rejects(send(budget, 'disburse', [1n, recipient.address, 1n]));
  await advance(3601);
  assert.equal(await budget.read('remainingThisPeriod', [1n]), 50n);
  await assert.rejects(send(budget, 'disburse', [1n, recipient.address, 51n]));
  await send(budget, 'disburse', [1n, recipient.address, 50n]);
  assert.equal(await budget.read('remainingTotal', [1n]), 0n);
  console.log('Local navigator integration passed: all 8 bundled deployments; fixed/multiplier onboarding, Merkle membership, signed ERC20 permit/replay, NFT ownership/replay, weighted signal vote, timelock hash/delay/replay/cancel, vesting cliff/claim/loot/revoke, treasury module authorization/native/ERC20 batches/rollover/ceiling, subscription native/ERC20 dues/burn/conversion/reward/re-enrollment. Real DAO/tokens; MockAvatar replaces production QuaiVault.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
