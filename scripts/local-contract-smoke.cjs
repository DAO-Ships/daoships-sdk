/*
 * Optional: npm run build && node scripts/local-contract-smoke.cjs
 * Requires sibling daoships-contracts dependencies and source-current compiled artifacts.
 * Never compiles, modifies the contracts checkout, reads dotenv, or uses a public RPC.
 * Hardhat is an existing development prerequisite, not an SDK dependency.
 */
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
  const hre = fromContracts('hardhat');
  assert.equal(hre.network.name, 'hardhat');
  const { ethers } = hre;
  const [owner, recipient] = await ethers.getSigners();
  const checkedSources = new Set();
  async function deploy(name, args = []) {
    const artifact = await hre.artifacts.readArtifact(name);
    const build = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
    assert.ok(build, `Missing compiler build info for ${name}; compile the contracts separately.`);
    const compiled = build.output.contracts[artifact.sourceName][name];
    // A compiler batch can contain unrelated stale contracts: verify this artifact's
    // metadata dependency closure rather than every file in the entire compiler batch.
    for (const source of Object.keys(JSON.parse(compiled.metadata).sources)) {
      const key = `${build.id}:${source}`;
      if (checkedSources.has(key)) continue;
      const file = path.join(contractsRoot, source.startsWith('@') ? 'node_modules' : '', source);
      assert.ok(fs.readFileSync(file, 'utf8') === build.input.sources[source].content, `Stale artifact source: ${source}`);
      checkedSources.add(key);
    }
    assert.equal(artifact.bytecode.slice(2), build.output.contracts[artifact.sourceName][name].evm.bytecode.object, `${name} artifact/compiler bytecode mismatch`);
    const contract = await (await ethers.getContractFactory(name)).deploy(...args);
    await contract.waitForDeployment(); return contract;
  }
  const sharesSingleton = await deploy('SharesERC20'), lootSingleton = await deploy('LootERC20');
  const daoSingleton = await deploy('DAOShip'), multisend = await deploy('MultiSendCallOnly');
  const existingVault = await deploy('MockAvatar');
  const factory = await deploy('DAOShipLauncher', [await daoSingleton.getAddress(), await sharesSingleton.getAddress(), await lootSingleton.getAddress()]);
  const vaultFactory = await deploy('MockQuaiVaultFactory');
  const combined = await deploy('DAOShipAndVaultLauncher', [await factory.getAddress(), await vaultFactory.getAddress(), await multisend.getAddress()]);
  const treasuryToken = await deploy('MockERC20', ['SDK Treasury', 'SDKT']);
  const initialization = {
    multisendLibrary: await multisend.getAddress(),
    governanceConfig: { votingPeriod: 60, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 1000n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 600 },
    navigators: [], navigatorPermissions: [], initMembers: [owner.address], initShareAmounts: [100n], initLootAmounts: [50n],
    guildTokens: [ethers.ZeroAddress, await treasuryToken.getAddress()], pauseSharesOnLaunch: false, pauseLootOnLaunch: false,
  };
  const params = { initialization, shareTokenName: 'SDK Shares', shareTokenSymbol: 'SDK', lootTokenName: 'SDK Loot', lootTokenSymbol: 'SDKL', sharesSalt: 1n, lootSalt: 2n, daoShipSalt: 3n };
  const directReceipt = await (await owner.sendTransaction({ to: await factory.getAddress(), data: sdk.encodeLaunchDAOShip({ ...params, existingVault: await existingVault.getAddress() }) })).wait();
  const directEvent = sdk.parseContractEvents(directReceipt, 'DAOShipLauncher', await factory.getAddress(), 'LaunchDAOShip')[0];
  assert.ok(directEvent);
  const predicted = sdk.predictDAOShipAddresses({ factory: await factory.getAddress(), sender: owner.address,
    singletons: { daoShip: await daoSingleton.getAddress(), shares: await sharesSingleton.getAddress(), loot: await lootSingleton.getAddress() }, ...params });
  assert.equal(directEvent.args.daoShip.toLowerCase(), predicted.daoShip.toLowerCase());
  const existingReceipt = await (await owner.sendTransaction({ to: await combined.getAddress(), data: sdk.encodeLaunchDAOShipWithVault({ ...params, existingVault: await existingVault.getAddress() }) })).wait();
  const existingEvent = sdk.parseContractEvents(existingReceipt, 'DAOShipAndVaultLauncher', await combined.getAddress(), 'LaunchDAOShipAndVault')[0];
  assert.equal(existingEvent.args.newVault, false); assert.equal(existingEvent.args.vault, await existingVault.getAddress());
  const newParams = { ...params, sharesSalt: 11n, lootSalt: 12n, daoShipSalt: 13n, vaultOwners: [owner.address], vaultThreshold: 1n, vaultSalt: 14n };
  const launchReceipt = await (await owner.sendTransaction({ to: await combined.getAddress(), data: sdk.encodeLaunchDAOShipAndVault(newParams) })).wait();
  const launched = sdk.parseContractEvents(launchReceipt, 'DAOShipAndVaultLauncher', await combined.getAddress(), 'LaunchDAOShipAndVault')[0];
  assert.equal(launched.args.newVault, true);
  const daoAddress = launched.args.daoShip;
  const dao = await ethers.getContractAt('DAOShip', daoAddress);
  const shares = await ethers.getContractAt('SharesERC20', launched.args.shares);
  assert.equal(await shares.balanceOf(owner.address), 100n);
  assert.equal(await dao.votingPeriod(), 60n);
  assert.equal(await vaultFactory.sixParamCalled(), true);
  assert.equal(await vaultFactory.lastInitialModules(0), daoAddress);
  assert.equal(await vaultFactory.lastInitialDelegatecallTargets(0), await multisend.getAddress());
  const action = sdk.buildGovernanceAction(daoAddress, { method: 'mintShares', accounts: [recipient.address], amounts: [25n] });
  const proposalData = sdk.encodeProposal([action]);
  const onChainCommitment = await dao.hashOperation(proposalData);
  assert.equal(onChainCommitment, sdk.hashProposalData(proposalData));
  assert.equal(sdk.verifyProposalDataHash(proposalData, onChainCommitment), true);
  assert.deepEqual(sdk.decodeProposal(proposalData), [{ operation: 0, ...action }]);
  const daoClient = new sdk.ContractClient('DAOShip', daoAddress);
  await hre.network.provider.send('evm_increaseTime', [2]); await hre.network.provider.send('evm_mine');
  const submit = daoClient.encode('submitProposal', [proposalData, 0n, 'SDK local governance mint']);
  const submitted = await (await owner.sendTransaction(submit)).wait();
  const id = sdk.parseSubmitReceipt(submitted, daoAddress);
  assert.equal(await dao.state(id), BigInt(sdk.ProposalState.Voting));
  await (await owner.sendTransaction(daoClient.encode('submitVote', [BigInt(id), true]))).wait();
  await hre.network.provider.send('evm_increaseTime', [61]); await hre.network.provider.send('evm_mine');
  assert.equal(await dao.state(id), BigInt(sdk.ProposalState.Ready));
  const processed = await (await owner.sendTransaction({ ...daoClient.encode('processProposal', [BigInt(id), proposalData]), gasLimit: 1_000_000n })).wait();
  sdk.assertActionSucceeded(processed, daoAddress, id);
  assert.equal(await shares.balanceOf(recipient.address), 25n);
  assert.equal(await shares.totalSupply(), 125n);
  // Real clone EIP-2612 acceptance: SDK typed data -> local signer -> SDK calldata.
  const network = await ethers.provider.getNetwork();
  const deadline = BigInt((await ethers.provider.getBlock('latest')).timestamp) + 3600n;
  async function expectRevert(send, expectedName) {
    await assert.rejects(async () => { await (await send()).wait(); }, error => {
      const decoded = sdk.decodeRevert(error);
      assert.equal(decoded?.name, expectedName, `Expected ${expectedName}, received ${error.message}`);
      return true;
    });
  }
  for (const [kind, target] of [['SharesERC20', launched.args.shares], ['LootERC20', launched.args.loot]]) {
    const token = await ethers.getContractAt(kind, target);
    const tokenClient = new sdk.ContractClient(kind, target);
    const input = { token: target, name: await token.name(), chainId: network.chainId,
      owner: owner.address, spender: recipient.address, value: 7n, nonce: await token.nonces(owner.address), deadline };
    const typed = sdk.buildPermitTypedData(input);
    assert.equal(ethers.TypedDataEncoder.hashDomain(typed.domain), await token.DOMAIN_SEPARATOR());
    const sign = async data => ethers.Signature.from(await owner.signTypedData(data.domain, data.types, data.value));
    const permit = (signature, expiry = deadline) => tokenClient.encode('permit', [owner.address, recipient.address, input.value, expiry,
      BigInt(signature.v), signature.r, signature.s]);
    const wrongChain = await sign(sdk.buildPermitTypedData({ ...input, chainId: network.chainId + 1n }));
    await expectRevert(() => recipient.sendTransaction({ ...permit(wrongChain), gasLimit: 250_000n }), 'ERC2612InvalidSigner');
    assert.equal(await token.nonces(owner.address), input.nonce, 'Rejected permit must not consume a nonce');
    const expired = await sign(sdk.buildPermitTypedData({ ...input, deadline: 1n }));
    await expectRevert(() => recipient.sendTransaction({ ...permit(expired, 1n), gasLimit: 250_000n }), 'ERC2612ExpiredSignature');
    assert.equal(await token.nonces(owner.address), input.nonce);
    const signature = await sign(typed);
    const receipt = await (await recipient.sendTransaction(permit(signature))).wait();
    assert.equal(sdk.parseContractEvents(receipt, kind, target, 'Approval').length, 1);
    assert.equal(await token.allowance(owner.address, recipient.address), 7n);
    assert.equal(await token.nonces(owner.address), input.nonce + 1n);
    await expectRevert(() => recipient.sendTransaction({ ...permit(signature), gasLimit: 250_000n }), 'ERC2612InvalidSigner');
    assert.equal(await token.nonces(owner.address), input.nonce + 1n, 'Replay must not consume another nonce');
    const otherClone = kind === 'SharesERC20' ? directEvent.args.shares : directEvent.args.loot;
    await expectRevert(() => recipient.sendTransaction({ ...permit(signature), to: otherClone, gasLimit: 250_000n }), 'ERC2612InvalidSigner');
    await expectRevert(() => recipient.sendTransaction({ ...tokenClient.encode('transferFrom', [owner.address, recipient.address, 8n]), gasLimit: 250_000n }), 'ERC20InsufficientAllowance');
    assert.equal(await token.allowance(owner.address, recipient.address), 7n);
    const before = await token.balanceOf(recipient.address);
    await (await recipient.sendTransaction(tokenClient.encode('transferFrom', [owner.address, recipient.address, 3n]))).wait();
    assert.equal(await token.balanceOf(recipient.address), before + 3n);
    assert.equal(await token.allowance(owner.address, recipient.address), 4n);
  }

  // Native + ERC20 ragequit uses a different recipient so transaction gas cannot
  // obscure the exact beneficiary balance delta. Supplies share the same denominator.
  const avatar = launched.args.vault;
  const loot = await ethers.getContractAt('LootERC20', launched.args.loot);
  await (await owner.sendTransaction({ to: avatar, value: 1750n })).wait();
  await (await treasuryToken.mint(avatar, 3500n)).wait();
  const nativeBefore = await ethers.provider.getBalance(recipient.address);
  const tokenBefore = await treasuryToken.balanceOf(recipient.address);
  const sharesBefore = await shares.balanceOf(owner.address), lootBefore = await loot.balanceOf(owner.address);
  const sharesSupply = await shares.totalSupply(), lootSupply = await loot.totalSupply();
  const burnShares = 10n, burnLoot = 5n;
  const denominator = sharesSupply + lootSupply;
  const nativePayout = 1750n * (burnShares + burnLoot) / denominator;
  const tokenPayout = 3500n * (burnShares + burnLoot) / denominator;
  const tokens = [ethers.ZeroAddress, await treasuryToken.getAddress()];
  const quote = sdk.quoteRagequit({ sharesSupply, lootSupply, memberShares: sharesBefore, memberLoot: lootBefore,
    sharesToBurn: burnShares, lootToBurn: burnLoot, minRetentionBps: await dao.minRetentionPercent(),
    guildTokens: [{ address: tokens[0], balance: await ethers.provider.getBalance(avatar) },
      { address: tokens[1], balance: await treasuryToken.balanceOf(avatar) }], tokens });
  assert.deepEqual(quote.withdrawals.map(row => row.amount), [nativePayout, tokenPayout]);
  await expectRevert(() => owner.sendTransaction({ ...daoClient.encode('ragequit', [recipient.address, burnShares, burnLoot, [...tokens].reverse()]), gasLimit: 500_000n }), 'TokensNotSorted');
  assert.equal(await shares.balanceOf(owner.address), sharesBefore, 'Rejected ragequit must not burn shares');
  assert.equal(await loot.balanceOf(owner.address), lootBefore, 'Rejected ragequit must not burn loot');
  const ragequit = await (await owner.sendTransaction(daoClient.encode('ragequit', [recipient.address, burnShares, burnLoot, tokens]))).wait();
  const quitEvent = sdk.parseContractEvents(ragequit, 'DAOShip', daoAddress, 'Ragequit')[0];
  assert.ok(quitEvent);
  assert.equal(quitEvent.args.member, owner.address); assert.equal(quitEvent.args.to, recipient.address);
  assert.equal(quitEvent.args.sharesToBurn, burnShares); assert.equal(quitEvent.args.lootToBurn, burnLoot);
  assert.deepEqual([...quitEvent.args.tokens], tokens); assert.deepEqual([...quitEvent.args.amounts], [nativePayout, tokenPayout]);
  assert.deepEqual([...quitEvent.args.amounts], quote.withdrawals.map(row => row.amount));
  assert.equal(await ethers.provider.getBalance(recipient.address), nativeBefore + nativePayout);
  assert.equal(await treasuryToken.balanceOf(recipient.address), tokenBefore + tokenPayout);
  assert.equal(await shares.balanceOf(owner.address), sharesBefore - burnShares);
  assert.equal(await loot.balanceOf(owner.address), lootBefore - burnLoot);
  assert.equal(await shares.totalSupply(), sharesSupply - burnShares);
  assert.equal(await loot.totalSupply(), lootSupply - burnLoot);
  assert.equal(await ethers.provider.getBalance(avatar), 1750n - nativePayout);
  assert.equal(await treasuryToken.balanceOf(avatar), 3500n - tokenPayout);

  // A successful outer receipt must not mask a failed proposal action. The first
  // action mints shares; the second attempts an impossible transfer from the vault.
  // MultiSend rollback must undo the first action while recording actionFailed.
  const failedData = sdk.encodeProposal([
    sdk.buildGovernanceAction(daoAddress, { method: 'mintShares', accounts: [recipient.address], amounts: [1n] }),
    new sdk.ContractClient('SharesERC20', launched.args.shares).encode('transfer', [recipient.address, 1n]),
  ]);
  async function processVotedProposal(data, approved, details, client = daoClient, target = daoAddress) {
    await hre.network.provider.send('evm_increaseTime', [2]); await hre.network.provider.send('evm_mine');
    const submitReceipt = await (await owner.sendTransaction(client.encode('submitProposal', [data, 0n, details]))).wait();
    const proposalId = sdk.parseSubmitReceipt(submitReceipt, target);
    await (await owner.sendTransaction(client.encode('submitVote', [BigInt(proposalId), approved]))).wait();
    await hre.network.provider.send('evm_increaseTime', [61]); await hre.network.provider.send('evm_mine');
    const receipt = await (await owner.sendTransaction({ ...client.encode('processProposal', [BigInt(proposalId), data]), gasLimit: 1_000_000n })).wait();
    return { proposalId, receipt };
  }
  const recipientShares = await shares.balanceOf(recipient.address), supply = await shares.totalSupply();
  const failed = await processVotedProposal(failedData, true, 'SDK expected action failure');
  assert.equal(failed.receipt.status, 1);
  assert.equal(sdk.parseProcessReceipt(failed.receipt, daoAddress, failed.proposalId), 'action_failed');
  assert.throws(() => sdk.assertActionSucceeded(failed.receipt, daoAddress, failed.proposalId), { code: 'ACTION_FAILED' });
  assert.equal(await shares.balanceOf(recipient.address), recipientShares, 'Failed MultiSend must roll back earlier mint');
  assert.equal(await shares.totalSupply(), supply);
  assert.equal(await dao.state(failed.proposalId), BigInt(sdk.ProposalState.Processed));
  await expectRevert(() => owner.sendTransaction({ ...daoClient.encode('processProposal', [BigInt(failed.proposalId), failedData]), gasLimit: 1_000_000n }), 'NotReady');
  const defeated = await processVotedProposal('0x', false, 'SDK expected defeated closure');
  assert.equal(sdk.parseProcessReceipt(defeated.receipt, daoAddress, defeated.proposalId), 'defeated');
  assert.throws(() => sdk.assertActionSucceeded(defeated.receipt, daoAddress, defeated.proposalId), { code: 'PROPOSAL_DEFEATED' });
  // A vault may itself hold membership and register its DAO's shares/loot as
  // treasury assets. Solidity burns that vault's membership before payout reads.
  const memberVault = await existingVault.getAddress(), memberDao = directEvent.args.daoShip;
  const memberDaoClient = new sdk.ContractClient('DAOShip', memberDao);
  const vaultShares = await ethers.getContractAt('SharesERC20', directEvent.args.shares);
  const vaultLoot = await ethers.getContractAt('LootERC20', directEvent.args.loot);
  const sharesAddress = await vaultShares.getAddress(), lootAddress = await vaultLoot.getAddress();
  await (await existingVault.enableModule(memberDao)).wait();
  await (await existingVault.enableModule(owner.address)).wait();
  const registry = sdk.encodeProposal([
    sdk.buildGovernanceAction(memberDao, { method: 'setGuildTokens', tokens: [sharesAddress, lootAddress], enabled: [true, true] }),
  ]);
  const registered = await processVotedProposal(registry, true, 'Register membership treasury assets', memberDaoClient, memberDao);
  sdk.assertActionSucceeded(registered.receipt, memberDao, registered.proposalId);
  await (await vaultShares.transfer(memberVault, 50n)).wait();
  await (await vaultLoot.transfer(memberVault, 30n)).wait();
  const vaultSelection = [sharesAddress, lootAddress].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const vaultQuote = sdk.quoteRagequit({ sharesSupply: await vaultShares.totalSupply(), lootSupply: await vaultLoot.totalSupply(),
    memberShares: 50n, memberLoot: 30n, sharesToBurn: 10n, lootToBurn: 10n, minRetentionBps: 0n,
    guildTokens: [{ address: sharesAddress, balance: 50n }, { address: lootAddress, balance: 30n }], tokens: vaultSelection,
    burnFromTreasury: { sharesToken: sharesAddress, lootToken: lootAddress } });
  const preBalances = [await vaultShares.balanceOf(recipient.address), await vaultLoot.balanceOf(recipient.address)];
  const vaultExit = memberDaoClient.encode('ragequit', [recipient.address, 10n, 10n, vaultSelection]);
  const exited = await (await existingVault.execTransactionFromModule(memberDao, 0n, vaultExit.data, 0)).wait();
  const vaultExitEvent = sdk.parseContractEvents(exited, 'DAOShip', memberDao, 'Ragequit')[0];
  assert.ok(vaultExitEvent, 'The vault-as-member ragequit must actually execute');
  assert.deepEqual([...vaultExitEvent.args.amounts], vaultQuote.withdrawals.map(row => row.amount));
  const sharesQuote = vaultQuote.withdrawals.find(row => row.token.toLowerCase() === sharesAddress.toLowerCase());
  const lootQuote = vaultQuote.withdrawals.find(row => row.token.toLowerCase() === lootAddress.toLowerCase());
  assert.equal(sharesQuote.balance, 40n); assert.equal(lootQuote.balance, 20n);
  assert.equal(await vaultShares.balanceOf(recipient.address), preBalances[0] + sharesQuote.amount);
  assert.equal(await vaultLoot.balanceOf(recipient.address), preBalances[1] + lootQuote.amount);
  console.log('Local EVM smoke passed: three launch paths, CREATE2, governance mint; Shares/Loot clone permits with replay/expiry/wrong-chain/wrong-clone rejection and transferFrom; native/ERC20 and vault-member post-burn ragequit accounting; failed-action rollback and defeated closure. Vault factory/avatar and treasury ERC20 are test doubles; no public network or production vault validation.');

}
main().catch(error => { console.error(error); process.exitCode = 1; });
