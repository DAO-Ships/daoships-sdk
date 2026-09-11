// Local SDK execution coverage for every DAOShip function. No dotenv or public RPC.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { FunctionCoverage } = require('./local-function-coverage.cjs');
const contractsRoot = path.resolve(__dirname, '../../daoships-contracts');
process.env.HARDHAT_CONFIG = path.join(__dirname, 'local-hardhat.config.cjs');
process.env.HARDHAT_NETWORK = 'hardhat';
const fromContracts = createRequire(path.join(contractsRoot, 'package.json'));

async function main() {
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../dist/index.js')).href);
  const hre = fromContracts('hardhat');
  assert.equal(hre.network.name, 'hardhat');
  const { ethers } = hre;
  const [owner, member, operator, outsider] = await ethers.getSigners();
  const checked = new Set();
  async function deploy(name) {
    const artifact = await hre.artifacts.readArtifact(name);
    const build = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:${name}`);
    assert.ok(build, `Missing source-current build info for ${name}`);
    const compiled = build.output.contracts[artifact.sourceName][name];
    for (const source of Object.keys(JSON.parse(compiled.metadata).sources)) {
      const key = `${build.id}:${source}`;
      if (checked.has(key)) continue;
      assert.equal(fs.readFileSync(path.join(contractsRoot, source.startsWith('@') ? 'node_modules' : '', source), 'utf8'), build.input.sources[source].content, `Stale artifact: ${source}`);
      checked.add(key);
    }
    assert.equal(artifact.bytecode.slice(2), compiled.evm.bytecode.object);
    const result = await new ethers.ContractFactory(artifact.abi, artifact.bytecode, owner).deploy();
    await result.waitForDeployment(); return result;
  }
  async function clone(name) {
    const singleton = await deploy(name);
    const result = await new ethers.ContractFactory([], sdk.minimalProxyBytecode(await singleton.getAddress()), owner).deploy();
    await result.waitForDeployment();
    return ethers.getContractAt(name, await result.getAddress());
  }
  const dao = await clone('DAOShip'), shares = await clone('SharesERC20'), loot = await clone('LootERC20');
  const vault = await deploy('MockAvatar'), multisend = await deploy('MultiSendCallOnly');
  const target = await dao.getAddress(), avatar = await vault.getAddress();
  const client = new sdk.ContractClient('DAOShip', target, { call: request => ethers.provider.call(request) });
  const coverage = new FunctionCoverage(sdk, ['DAOShip']);
  async function send(method, args, signer = owner, options = {}) {
    const call = client.encode(method, args, options);
    const receipt = await (await signer.sendTransaction({ ...call, gasLimit: 3_000_000n })).wait();
    coverage.write('DAOShip', call, receipt);
    return receipt;
  }
  const rejects = async (method, args, signer = outsider, options = {}) => {
    await assert.rejects(send(method, args, signer, options), error => {
      assert.ok(sdk.decodeRevert(error), `Expected a decoded contract revert: ${error.message}`);
      return true;
    });
  };
  const advance = async seconds => { await hre.network.provider.send('evm_increaseTime', [seconds]); await hre.network.provider.send('evm_mine'); };
  const config = { votingPeriod: 60, gracePeriod: 0, proposalOffering: 3n, quorumPercent: 1000n, sponsorThreshold: 10n, minRetentionPercent: 0n, defaultExpiryWindow: 600 };
  await (await shares.initialize(target, 'Function shares', 'SH')).wait();
  await (await loot.initialize(target, 'Function loot', 'LT')).wait();
  const init = sdk.encodeLaunchInitParams({ multisendLibrary: await multisend.getAddress(), governanceConfig: config,
    navigators: [], navigatorPermissions: [], initMembers: [owner.address, member.address],
    initShareAmounts: [1000n, 100n], initLootAmounts: [10n, 0n], guildTokens: [ethers.ZeroAddress],
    pauseSharesOnLaunch: false, pauseLootOnLaunch: false }, avatar);
  const fields = ethers.AbiCoder.defaultAbiCoder().decode(sdk.INIT_PARAMS_TYPES, init).toArray();
  fields[0] = await loot.getAddress(); fields[1] = await shares.getAddress();
  const setup = ethers.AbiCoder.defaultAbiCoder().encode(sdk.INIT_PARAMS_TYPES, fields);
  const setupReceipt = await send('setUp', [setup]);
  assert.equal(sdk.parseContractEvents(setupReceipt, 'DAOShip', target, 'SetupComplete').length, 1);
  assert.equal(await dao.totalSupply(), 1110n);
  await rejects('setUp', [setup]);
  await (await vault.enableModule(target)).wait();
  await (await owner.sendTransaction({ to: avatar, value: 10000n })).wait();

  const submit = async (data, signer = owner, value = 0n) => BigInt(sdk.parseSubmitReceipt(await send('submitProposal', [data, 0n, 'SDK function coverage'], signer, { value }), target));
  const govern = async (calls, expected = 'executed') => {
    const data = sdk.encodeProposal(calls.map(call => sdk.buildGovernanceAction(target, call)));
    const id = await submit(data);
    await send('submitVote', [id, true]);
    await advance(61);
    const receipt = await send('processProposal', [id, data]);
    assert.equal(sdk.parseProcessReceipt(receipt, target, Number(id)), expected);
    return receipt;
  };
  // Every privileged entry rejects an ordinary account, including the governance wrapper.
  for (const [method, args] of [
    ['mintShares', [[member.address], [1n]]], ['mintLoot', [[member.address], [1n]]],
    ['burnShares', [[member.address], [1n]]], ['burnLoot', [[owner.address], [1n]]],
    ['convertSharesToLoot', [member.address, 1n]], ['setAdminConfig', [true, true]],
    ['setGovernanceConfig', [sdk.encodeGovernanceConfig(config)]], ['setGuildTokens', [[ethers.ZeroAddress], [false]]],
    ['setNavigators', [[operator.address], [7n]]], ['lockAdmin', []], ['lockManager', []], ['lockGovernor', []],
    ['executeAsGovernance', [target, 0n, client.encode('lockAdmin', []).data]],
  ]) await rejects(method, args);

  await govern([{ method: 'setNavigators', navigators: [operator.address], permissions: [7n] }]);
  assert.equal(await dao.navigators(operator.address), 7n);
  assert.equal(await dao.isAdmin(operator.address), true);
  assert.equal(await dao.isManager(operator.address), true);
  assert.equal(await dao.isGovernor(operator.address), true);
  // Exercise manager calls directly and compare cached supplies with the actual tokens.
  await send('mintShares', [[member.address], [20n]], operator);
  await send('mintLoot', [[member.address], [12n]], operator);
  await send('burnShares', [[member.address], [3n]], operator);
  await send('burnLoot', [[member.address], [2n]], operator);
  await send('convertSharesToLoot', [member.address, 7n], operator);
  assert.equal(await shares.balanceOf(member.address), 110n);
  assert.equal(await loot.balanceOf(member.address), 17n);
  assert.equal(await dao.totalShares(), await shares.totalSupply());
  assert.equal(await dao.totalLoot(), await loot.totalSupply());
  await send('setAdminConfig', [true, true], operator);
  assert.equal(await shares.paused(), true); assert.equal(await loot.paused(), true);
  await assert.rejects(shares.transfer(member.address, 1n));
  await send('setAdminConfig', [false, false], operator);
  assert.equal(await shares.paused(), false); assert.equal(await loot.paused(), false);
  await send('setGovernanceConfig', [sdk.encodeGovernanceConfig({ ...config, proposalOffering: 5n })], operator);
  assert.equal(await dao.proposalOffering(), 5n);
  await govern([{ method: 'setGuildTokens', tokens: [ethers.ZeroAddress], enabled: [false] }]);
  assert.deepEqual([...await dao.getGuildTokens()], []);
  await govern([{ method: 'setGuildTokens', tokens: [ethers.ZeroAddress], enabled: [true] }]);
  assert.deepEqual([...await dao.getGuildTokens()], [ethers.ZeroAddress]);

  // A nonmember pays exactly the offering, then a member sponsors the proposal.
  await rejects('submitProposal', ['0x', 0n, 'Missing offering']);
  await rejects('submitProposal', ['0x', 0n, 'Extra offering'], outsider, { value: 6n });
  const treasuryBeforeOffering = await ethers.provider.getBalance(avatar);
  const sponsored = await submit('0x', outsider, 5n);
  assert.equal(await ethers.provider.getBalance(avatar), treasuryBeforeOffering + 5n);
  assert.equal(await dao.state(sponsored), BigInt(sdk.ProposalState.Submitted));
  await rejects('sponsorProposal', [sponsored]);
  await send('sponsorProposal', [sponsored], member);
  assert.equal(await dao.state(sponsored), BigInt(sdk.ProposalState.Voting));
  const second = await submit('0x');
  await send('submitVotes', [[sponsored, second], [true, false]]);
  assert.equal(await dao.memberVoted(owner.address, sponsored), true);
  assert.equal(await dao.memberVoted(owner.address, second), true);
  // Atomic batch rejection: a later duplicate must roll back the earlier new vote.
  const fresh = await submit('0x');
  await rejects('submitVotes', [[fresh, sponsored], [true, true]], owner);
  assert.equal(await dao.memberVoted(owner.address, fresh), false);
  await rejects('cancelProposal', [fresh]);
  await send('cancelProposal', [fresh]);
  assert.equal(await dao.state(fresh), BigInt(sdk.ProposalState.Cancelled));
  await rejects('submitVote', [fresh, true], owner);
  await advance(61);
  assert.equal(sdk.parseProcessReceipt(await send('processProposal', [sponsored, '0x']), target, Number(sponsored)), 'executed');
  assert.equal(sdk.parseProcessReceipt(await send('processProposal', [second, '0x']), target, Number(second)), 'defeated');

  // SDK calldata and quote must match the native payout and supply effects.
  const before = await ethers.provider.getBalance(outsider.address);
  const quote = sdk.quoteRagequit({ sharesSupply: await shares.totalSupply(), lootSupply: await loot.totalSupply(),
    memberShares: await shares.balanceOf(owner.address), memberLoot: await loot.balanceOf(owner.address), sharesToBurn: 10n, lootToBurn: 5n,
    minRetentionBps: 0n, guildTokens: [{ address: ethers.ZeroAddress, balance: await ethers.provider.getBalance(avatar) }], tokens: [ethers.ZeroAddress] });
  const exited = await send('ragequit', [outsider.address, 10n, 5n, [ethers.ZeroAddress]]);
  assert.equal(sdk.parseContractEvents(exited, 'DAOShip', target, 'Ragequit').length, 1);
  assert.equal(await ethers.provider.getBalance(outsider.address), before + quote.withdrawals[0].amount);
  assert.equal(await dao.totalShares(), await shares.totalSupply());
  assert.equal(await dao.totalLoot(), await loot.totalSupply());

  // Locks block future grants, while existing operators and governance remain usable.
  await govern([{ method: 'lockAdmin' }, { method: 'lockManager' }, { method: 'lockGovernor' }]);
  for (const lock of ['adminLock', 'managerLock', 'governorLock']) assert.equal(await client.read(lock, []), true);
  for (const permission of [1n, 2n, 4n]) {
    await govern([{ method: 'setNavigators', navigators: [outsider.address], permissions: [permission] }], 'action_failed');
    assert.equal(await dao.navigators(outsider.address), 0n);
  }
  const memberLoot = await loot.balanceOf(member.address);
  await send('mintLoot', [[member.address], [1n]], operator);
  await govern([{ method: 'mintLoot', accounts: [member.address], amounts: [1n] }]);
  assert.equal(await loot.balanceOf(member.address), memberLoot + 2n);
  await govern([{ method: 'setNavigators', navigators: [operator.address], permissions: [0n] }]);
  await rejects('mintLoot', [[member.address], [1n]], operator);

  await coverage.reads('DAOShip', client, dao, ethers.provider, {
    'getCurrentVotes(address)': [owner.address], 'getPriorVotes(address,uint256)': [owner.address, 0n],
    'getProposalStatus(uint32)': [sponsored], 'guildTokens(address)': [ethers.ZeroAddress], 'hashOperation(bytes)': ['0x'],
    'isAdmin(address)': [operator.address], 'isGovernor(address)': [operator.address], 'isManager(address)': [operator.address],
    'memberVoted(address,uint32)': [owner.address, sponsored], 'navigators(address)': [operator.address],
    'proposals(uint32)': [sponsored], 'state(uint32)': [sponsored],
  });
  coverage.assertComplete();
  console.log('DAO function integration passed: initializer, governance/operator permissions, supply accounting, sponsored and batch voting, cancellation, outcomes, ragequit, locks and revocation. MockAvatar replaces production QuaiVault.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
