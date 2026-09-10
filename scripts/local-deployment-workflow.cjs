/* Opt-in local EVM deployment workflow acceptance. Reads source-current DAOShips and
 * adjacent QuaiVault build artifacts; does not compile, mutate either checkout or use RPC. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const contractsRoot = path.resolve(__dirname, '../../daoships-contracts');
const vaultRoot = process.env.DAOSHIPS_TEST_VAULT_CONTRACTS || path.resolve(__dirname, '../../../QUAI-VAULT/quaivault-contracts');
process.env.HARDHAT_CONFIG = path.join(__dirname, 'local-hardhat.config.cjs');
process.env.HARDHAT_NETWORK = 'hardhat';
const fromContracts = createRequire(path.join(contractsRoot, 'package.json'));
async function main() {
  const sdk = await import(pathToFileURL(path.resolve(__dirname, '../dist/index.js')));
  const workflows = await import(pathToFileURL(path.resolve(__dirname, '../dist/deployment-workflows.js')));
  const { NAVIGATOR_BYTECODES } = await import(pathToFileURL(path.resolve(__dirname, '../dist/navigator-bytecodes.js')));
  const hre = fromContracts('hardhat'), { ethers } = hre;
  assert.equal(hre.network.name, 'hardhat');
  const [owner, member] = await ethers.getSigners();
  const checked = new Set();
  function checkSource(root, artifact, build) {
    assert.ok(build, `Missing build info for ${artifact.contractName}`);
    const compiled = build.output.contracts[artifact.sourceName][artifact.contractName];
    for (const source of Object.keys(JSON.parse(compiled.metadata).sources)) {
      const key = `${root}:${build.id}:${source}`;
      if (checked.has(key)) continue;
      assert.equal(fs.readFileSync(path.join(root, source.startsWith('@') ? 'node_modules' : '', source), 'utf8'), build.input.sources[source].content, `Stale source: ${source}`);
      checked.add(key);
    }
    assert.equal(artifact.bytecode.slice(2), compiled.evm.bytecode.object);
    return artifact;
  }
  async function artifact(name, external = false) {
    if (!external) { const a = await hre.artifacts.readArtifact(name); return checkSource(contractsRoot, a, await hre.artifacts.getBuildInfo(`${a.sourceName}:${a.contractName}`)); }
    const file = path.join(vaultRoot, 'artifacts/contracts', `${name}.sol`, `${name}.json`);
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    const debug = JSON.parse(fs.readFileSync(file.replace('.json', '.dbg.json'), 'utf8'));
    return checkSource(vaultRoot, a, JSON.parse(fs.readFileSync(path.resolve(path.dirname(file), debug.buildInfo), 'utf8')));
  }
  async function deploy(name, args = [], external = false) {
    const a = await artifact(name, external), c = await new ethers.ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment(); return c;
  }
  const shares = await deploy('SharesERC20'), loot = await deploy('LootERC20'), dao = await deploy('DAOShip'), multisend = await deploy('MultiSendCallOnly');
  const vaultSingleton = await deploy('QuaiVault', [], true), vaultFactory = await deploy('QuaiVaultFactory', [await vaultSingleton.getAddress()], true);
  const launcher = await deploy('DAOShipLauncher', [await dao.getAddress(), await shares.getAddress(), await loot.getAddress()]);
  const combined = await deploy('DAOShipAndVaultLauncher', [await launcher.getAddress(), await vaultFactory.getAddress(), await multisend.getAddress()]);
  const deployment = { daoShipAndVaultLauncher: await combined.getAddress(), daoShipLauncher: await launcher.getAddress(), quaiVaultFactory: await vaultFactory.getAddress(), multisendCallOnly: await multisend.getAddress(),
    daoShipSingleton: await dao.getAddress(), sharesSingleton: await shares.getAddress(), lootSingleton: await loot.getAddress(), vaultSingleton: await vaultSingleton.getAddress() };
  const proxy = await artifact('QuaiVaultProxy', true);
  const provider = {
    getNetwork: () => ethers.provider.getNetwork(), call: request => ethers.provider.call(request), getCode: (a, tag) => ethers.provider.getCode(a, tag),
    getTransaction: hash => ethers.provider.getTransaction(hash), getTransactionReceipt: hash => ethers.provider.getTransactionReceipt(hash),
    async getBlock(_shard, tag) { const b = await ethers.provider.getBlock(tag); return b ? { hash: b.hash, woHeader: { number: b.number } } : null; },
  };
  const parameters = { shareTokenName: 'Workflow Shares', shareTokenSymbol: 'WFS', lootTokenName: 'Workflow Loot', lootTokenSymbol: 'WFL', sharesSalt: 1n, lootSalt: 2n, daoShipSalt: 3n,
    initialization: { multisendLibrary: deployment.multisendCallOnly, governanceConfig: { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 1000n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 600 },
      navigators: [], navigatorPermissions: [], initMembers: [owner.address], initShareAmounts: [1000n], initLootAmounts: [0n], guildTokens: [ethers.ZeroAddress], pauseSharesOnLaunch: false, pauseLootOnLaunch: false } };
  function store() {
    let value = null;
    return { async load() { return structuredClone(value); }, async compareAndSwap(_id, revision, next) {
      if ((value?.revision ?? null) !== revision) return false;
      value = structuredClone(next); return true;
    } };
  }
  const advanceTime = async seconds => { await hre.network.provider.send('evm_increaseTime', [seconds]); await hre.network.provider.send('evm_mine'); };
  const sender = plan => plan.from.toLowerCase() === member.address.toLowerCase() ? member : owner;
  const send = async (call, signer = owner) => signer.sendTransaction({ to: call.to, data: call.data, value: call.value });
  const executors = {
    transaction: { async execute(plan, step, ctx) { assert.ok(ctx.prepared.transaction); const tx = await send(step.calls[0], sender(plan)); await ctx.onSubmitted(tx.hash); return tx.wait(); } },
    creation: { async execute(plan, step, ctx) { const tx = await sender(plan).sendTransaction({ data: step.creationData }); await ctx.onSubmitted(tx.hash); return tx.wait(); } },
    vault: { async execute(plan, step, ctx) {
      assert.equal(plan.type, 'dao-launch', 'Owner consent is only used for existing-vault bootstrap');
      const vault = plan.type === 'dao-launch' ? plan.expected.vault : plan.vault;
      const client = new sdk.ContractClient('QuaiVault', vault);
      const call = ctx.prepared.calls[0]; assert.equal(ctx.prepared.calls.length, 1);
      const proposed = await (await send(client.encode('proposeTransaction(address,uint256,bytes)', [call.to, call.value, call.data]))).wait();
      const event = sdk.parseContractEvents(proposed, 'QuaiVault', vault, 'TransactionProposed')[0]; assert.ok(event);
      // Proposal status 1 is not a successful workflow setup/activation.
      await assert.rejects(workflows.verifyDeploymentWorkflowStep(plan, step.id, proposed, provider));
      await (await send(client.encode('approveTransaction', [event.args.txHash]))).wait();
      const tx = await send(client.encode('executeTransaction', [event.args.txHash])); await ctx.onSubmitted(tx.hash); return tx.wait();
    } },
    'dao-governance': { async execute(plan, step, ctx) {
      const client = new sdk.ContractClient('DAOShip', plan.daoShip);
      const signer = sender(plan);
      const submitted = await (await send(client.encode('submitProposal', [step.proposalData, 0n, 'Activate workflow navigator']), signer)).wait();
      if (plan.kind === 'BudgetNavigator') {
        assert.equal(await new sdk.ContractClient('QuaiVault', plan.vault, provider).read('isOwner', [signer.address]), false);
        await assert.rejects(workflows.verifyDeploymentWorkflowStep(plan, step.id, submitted, provider), { code: 'MISSING_EVENT' });
      }
      const id = sdk.parseSubmitReceipt(submitted, plan.daoShip);
      await (await send(client.encode('submitVote', [BigInt(id), true]), signer)).wait();
      await advanceTime(61);
      const call = client.encode('processProposal', [BigInt(id), step.proposalData]);
      const tx = await signer.sendTransaction({ to: call.to, data: call.data, value: 0n, gasLimit: 2_000_000n }); await ctx.onSubmitted(tx.hash); return tx.wait();
    } },
  };
  // Direct and combined existing-vault routes exercise real owner proposal+execution setup.
  for (const [i, route] of ['direct', 'existing-vault'].entries()) {
    const salt = ethers.toBeHex(BigInt(100 + i), 32);
    const expectedVault = await vaultFactory['predictWalletAddress(address,bytes32,address[],uint256,uint32,address[],address[])'](owner.address, salt, [owner.address], 1n, 0n, [], []);
    await (await vaultFactory['createWallet(address[],uint256,bytes32,uint32,address[],address[])']([owner.address], 1n, salt, 0n, [], [])).wait();
    const plan = workflows.buildDAOShipLaunchPlan({ route, chainId: 1337, from: owner.address, addressPolicy: 'evm', deployment, parameters: { ...parameters, sharesSalt: BigInt(i * 10 + 1), lootSalt: BigInt(i * 10 + 2), daoShipSalt: BigInt(i * 10 + 3) }, existingVault: expectedVault });
    const durable = store();
    for (let j = 0; j < plan.steps.length; j++) await workflows.advanceDeploymentWorkflow(plan, durable, executors, provider);
    assert.equal(Object.values((await durable.load()).steps).every(s => s.status === 'verified'), true);
    assert.deepEqual(await workflows.pendingVaultSetupCalls(plan, provider, { blockTag: await ethers.provider.getBlockNumber() }), []);
  }
  // New-vault route tests the real production-compatible proxy init hash and CREATE2 salt.
  const plan = workflows.buildDAOShipLaunchPlan({ route: 'new-vault', chainId: 1337, from: owner.address, addressPolicy: 'evm', deployment,
    parameters: { ...parameters, sharesSalt: 21n, lootSalt: 22n, daoShipSalt: 23n,
      initialization: { ...parameters.initialization, initMembers: [owner.address, member.address], initShareAmounts: [1000n, 1000n], initLootAmounts: [0n, 0n] } },
    vaultOwners: [owner.address], vaultThreshold: 1n, vaultSalt: 24n, vaultProxyBytecode: proxy.bytecode });
  const durable = store(); await workflows.advanceDeploymentWorkflow(plan, durable, executors, provider);
  const nft = await deploy('MockERC721'), tributeToken = await deploy('MockERC20', ['Workflow Tribute', 'WT']), poster = await deploy('Poster');
  await (await tributeToken.mint(owner.address, 1000n)).wait();
  await (await tributeToken.mint(member.address, 100n)).wait();
  const base = { daoShip: plan.expected.daoShip, name: 'Workflow navigator', description: 'SDK end-to-end plan' };
  const cap = { expiry: 0n, mintCap: 1000n, perAddressCap: 100n, allowlistRoot: ethers.ZeroHash };
  const configs = {
    OnboarderNavigator: { ...base, ...cap, shareMultiplier: 10000n, lootMultiplier: 0n, pricePerUnit: 0n, sharesPerUnit: 0n, lootPerUnit: 0n, minTribute: 1n },
    ERC20TributeNavigator: { ...base, ...cap, tributeToken: await tributeToken.getAddress(), pricePerShare: 10n ** 18n, pricePerLoot: 0n },
    NFTGatedNavigator: { ...base, ...cap, gateToken: await nft.getAddress(), sharesPerHolder: 1n, lootPerHolder: 0n, requireTribute: false, tributeAmount: 0n },
    SignalNavigator: { ...base, minSharesToCreatePoll: 1n, minDuration: 60n, maxDuration: 3600n, maxStartDelay: 3600n },
    TimelockNavigator: { ...base, delay: 600n, expiryWindow: 3600n }, VestingNavigator: base, BudgetNavigator: base,
    SubscriptionNavigator: { ...base, tokens: [ethers.ZeroAddress], feesPerPeriod: [1n], periodDuration: 3600n, graceDuration: 60n, startTime: 0n, collectorRewardBps: 0n, burnOnCollect: false, initialMembers: [] },
  };
  for (const kind of sdk.NAVIGATOR_KINDS) {
    const a = await artifact(kind); assert.equal(a.bytecode, NAVIGATOR_BYTECODES[kind]);
    const signer = kind === 'BudgetNavigator' ? member : owner;
    const expectedAddress = ethers.getCreateAddress({ from: signer.address, nonce: await signer.getNonce() });
    const navPlan = workflows.buildNavigatorDeploymentPlan({ chainId: 1337, from: signer.address, addressPolicy: 'evm', kind, config: configs[kind], bytecode: NAVIGATOR_BYTECODES[kind], expectedAddress, vault: plan.expected.vault,
      ...(kind === 'SignalNavigator' ? { signalEndorsement: { poster: await poster.getAddress(), currentNavigators: [] } } : {}),
      ...(kind === 'BudgetNavigator' ? { treasuryFunding: { token: await tributeToken.getAddress(), amount: 100n } } : {}) });
    const navStore = store();
    const { vault: _vaultExecutor, ...daoExecutors } = executors;
    assert.equal(navPlan.steps[1].kind, 'dao-governance');
    for (let i = 0; i < navPlan.steps.length; i++) await workflows.advanceDeploymentWorkflow(navPlan, navStore, daoExecutors, provider, {
      verifyCurrentSignalEndorsement: async (current, stage) => {
        const posts = (await poster.queryFilter(poster.filters.NewPost(plan.expected.vault, null, sdk.POSTER_TAGS.DAO_NAVIGATORS)));
        if (stage === 'before-activation') return posts.length === 0 && current.signalEndorsement.currentNavigators.length === 0;
        return posts.at(-1)?.args.content === current.signalEndorsement.content;
      },
    });
    assert.equal(Object.values((await navStore.load()).steps).every(s => s.status === 'verified'), true);
  }
  assert.equal(await tributeToken.balanceOf(plan.expected.vault), 100n);
  const liveVault = new sdk.ContractClient('QuaiVault', plan.expected.vault, provider);
  const enabledModules = await liveVault.read('getModules', []);
  assert.ok(enabledModules.length >= 2, 'Exercise a real pagination boundary');
  const fixedBlock = await ethers.provider.getBlockNumber();
  for (let i = 0; i < enabledModules.length; i++) {
    assert.equal(await sdk.resolveVaultModulePredecessor(provider, plan.expected.vault, enabledModules[i], { blockTag: fixedBlock, pageSize: 1 }),
      enabledModules[i - 1] ?? sdk.VAULT_MODULE_SENTINEL);
  }
  assert.equal(await sdk.resolveVaultModulePredecessor(provider, plan.expected.vault, member.address, { blockTag: fixedBlock, pageSize: 1 }), null);
  console.log('Deployment workflow acceptance passed: all 3 DAO launch plans, real QuaiVault CREATE2 predictions and owner-executed bootstrap, all 8 navigator activations through DAO governance, Budget activation and funding by a DAO member who is not a vault owner, Signal Poster endorsement, verified resumable checkpoints. No public network or mock vault consensus.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
