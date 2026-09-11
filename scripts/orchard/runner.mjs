import { resolve, dirname } from 'node:path';
import { AbiCoder, ContractFactory, Interface, Wallet, QuaiTransaction, Shard, Zone, ZeroAddress, ZeroHash, concat, keccak256, toBeHex, getAddress } from 'quais';
import { OrchardProvider } from './provider.mjs';
import * as sdk from '../../dist/index.js';
import { NAVIGATOR_BYTECODES } from '../../dist/navigator-bytecodes.js';
import { runOrchardRecoveryScenarios } from './recovery-scenarios.mjs';
import { verifyIndexedOrchardFixtures } from './indexer.mjs';
import { openFileRecoveryStore, openFileWorkflowStore } from '../conformance/file-store.mjs';
import { readBounded, openEvidence, encodeEvidence, evidenceHash, grindCreation, loadWalletKeys, boundedRead, boundedReadProvider, requireMinedRecovery, governanceExecutionId, waitForVotingSnapshot } from './support.mjs';

const fail = (message, code = 'INVALID_ARGUMENT') => { throw new sdk.DaoShipsError(code, message); };
const same = (a, b) => getAddress(a) === getAddress(b);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorCode = error => error instanceof sdk.DaoShipsError ? error.code : 'CHAIN_ERROR';
export async function sourceArtifact(root, name, source = `contracts/${name}.sol`) {
  const file = resolve(root, `artifacts/${source}/${name}.json`);
  const artifact = JSON.parse(await readBounded(file));
  const debug = JSON.parse(await readBounded(file.replace(/\.json$/, '.dbg.json')));
  const build = JSON.parse(await readBounded(resolve(dirname(file), debug.buildInfo)));
  const compiled = build.output.contracts[source][name];
  for (const dependency of Object.keys(JSON.parse(compiled.metadata).sources)) {
    const current = await readBounded(resolve(root, dependency.startsWith('@') ? 'node_modules' : '', dependency));
    if (current !== build.input.sources[dependency].content) fail('Compiler artifact has stale source inputs.');
  }
  if (artifact.contractName !== name || artifact.sourceName !== source || JSON.stringify(artifact.abi) !== JSON.stringify(compiled.abi) || artifact.bytecode !== `0x${compiled.evm.bytecode.object}`) fail('Artifact differs from compiler output.');
  return artifact;
}
/** Read-only readiness; uses the supplied provider to enforce live network and contract identity. */
export async function inspectOrchard(config, provider, options = {}) {
  if (config.chainId !== 15000 || config.schema !== 'testnet') fail('Orchard readiness requires chain15000/testnet.');
  if ((await boundedRead(() => provider.getNetwork())).chainId !== 15000n) fail('Refusing a network other than Orchard 15000.', 'CHAIN_MISMATCH');
  const discovered = await sdk.verifyDeployment(provider, { chainId: 15000, contracts: config.deployment, timeoutMs: 30000 });
  const posterCode = await boundedRead(() => provider.getCode(config.poster, discovered.blockNumber));
  if (posterCode === '0x') fail('Reviewed Poster address has no code.', 'INVALID_RESPONSE');
  const hosted = await sdk.connectDaoShipsSupabase({ network: 'testnet', schema: config.schema, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  return { chainId: 15000, dependency: 'quais@1.0.0-alpha.53', discovered,
    indexer: { schema: hosted.schema, checkpoint: hosted.checkpoint, health: hosted.health },
    observedAt: new Date().toISOString(), posterCodeHash: keccak256(posterCode) };
}
export async function executeOrchard(config, { keysFile, evidenceDirectory, configDirectory = process.cwd() }) {
  // Called only in explicit execute mode. Wallet keys come from local .env or environment.
  const evidence = await openEvidence(evidenceDirectory), unlock = await evidence.lock();
  const provider = boundedReadProvider(new OrchardProvider(config.rpcUrl, undefined, { usePathing: true }));
  let currentStage = 'readiness';
  const progress = (stage, detail = {}) => { currentStage = stage; process.stderr.write(JSON.stringify({ stage, ...detail }) + '\n'); };
  try {
    progress('readiness');
    const identity = { config, configDirectory: resolve(configDirectory) }, configHash = evidenceHash(identity);
    const previous = await evidence.get('configuration');
    if (previous && previous.hash !== configHash) fail('Evidence directory belongs to a different reviewed configuration.');
    if (!previous) await evidence.put('configuration', { hash: configHash, identity });
    const startup = await inspectOrchard(config, provider);
    await evidence.put('startup', startup);
    const keys = await loadWalletKeys(keysFile);
    const owner = new Wallet(keys.ORCHARD_OWNER_PRIVATE_KEY, provider), member = new Wallet(keys.ORCHARD_MEMBER_PRIVATE_KEY, provider);
    if (![owner.address, member.address].every(sdk.isCyprus1Address) || same(owner.address, member.address)) fail('Expected distinct Cyprus-1 Quai test wallets.');
    const accountIdentity = { owner: owner.address, member: member.address };
    const existingAccounts = await evidence.get('accounts');
    if (existingAccounts && evidenceHash(existingAccounts) !== evidenceHash(accountIdentity)) fail('Test wallets differ from the evidence session.');
    await evidence.put('accounts', accountIdentity);
    const recovery = await openFileRecoveryStore(resolve(evidence.root, 'recovery'));
    const workflow = await openFileWorkflowStore(resolve(evidence.root, 'workflows'));
    const chain = new sdk.DaoShipsChain(provider, 15000);
    const contractsRoot = resolve(import.meta.dirname, '../../../daoships-contracts');
    const proxyFile = resolve(configDirectory, config.vaultProxyArtifact);
    const proxy = JSON.parse(await readBounded(proxyFile));
    if (typeof proxy.bytecode !== 'string' || !/^0x[\da-f]{100,}$/i.test(proxy.bytecode)) fail('Invalid public vault proxy artifact.');
    const options = { confirmations: config.confirmations, timeoutMs: 30000 };
    async function checkBudget(request) {
      if ((await provider.getNetwork()).chainId !== 15000n || request.chainId !== 15000n) fail('Network changed before signing.', 'CHAIN_MISMATCH');
      const gas = BigInt(request.gasLimit ?? 0), fee = BigInt(request.gasPrice ?? request.maxFeePerGas ?? 0) + BigInt(request.minerTip ?? 0);
      if (!gas || !fee || gas > config.maxGasLimit || fee > config.maxFeePerGas || BigInt(request.value ?? 0) > config.maxValuePerTransaction) fail('Transaction exceeds the explicit acceptance spend limits.');
      const budget = await evidence.get('transaction-budget') ?? { attempts: 0 };
      if (budget.attempts >= config.maxTransactions) fail('Acceptance transaction limit reached.');
      await evidence.put('transaction-budget', { attempts: budget.attempts + 1 });
    }
    const boundedSigner = signer => ({ provider, getAddress: () => signer.getAddress(), estimateGas: request => signer.estimateGas(request),
      async sendTransaction(request) {
        const populated = await signer.populateQuaiTransaction(request);
        await checkBudget(populated);
        return signer.sendTransaction(populated);
      } });
    async function confirmed(hash, confirmations = config.confirmations) {
      const receipt = await provider.waitForTransaction(hash, confirmations, config.waitTimeoutMs);
      if (!receipt || receipt.status !== 1) fail('Transaction is pending or reverted; inspect evidence before continuing.', receipt?.status === 0 ? 'TX_REVERTED' : 'TX_PENDING');
      return receipt;
    }
    async function send(id, call, signer, onSubmitted = async () => {}, confirmations = config.confirmations) {
      progress('transaction', { id, operation: call.operation });
      const saved = await recovery.read(sdk.recoveryTransactionKey(id));
      let result;
      if (saved) {
        if (!same(saved.intent.from, signer.address) || !same(saved.intent.to, call.to) || saved.intent.data.toLowerCase() !== call.data.toLowerCase() || saved.intent.value !== call.value) fail('Recovery intent differs from its scenario action.');
        if (!saved.hash) fail('Uncertain transaction has no known hash; use explicit SDK recovery with independent RPC evidence.', 'TX_PENDING');
        await onSubmitted(saved.hash);
        await confirmed(saved.hash, confirmations);
        result = await sdk.inspectRecoveryTransaction(recovery, provider, id, { ...options, confirmations });
      } else {
        const prepare = () => chain.prepareCall(call, signer.address);
        const sent = await sdk.sendRecoverableTransaction(await prepare(), boundedSigner(signer), { id, store: recovery, refresh: prepare, timeoutMs: 30000 });
        progress('submitted', { id, hash: sent.transaction.hash });
        await onSubmitted(sent.transaction.hash);
        result = await sdk.waitForRecoveryTransaction(recovery, provider, id, sent.transaction, { ...options, confirmations, timeoutMs: config.waitTimeoutMs });
      }
      requireMinedRecovery(result);
      const receipt = await provider.getTransactionReceipt(result.record.receipt.hash);
      await evidence.put(`receipt:${id}`, { id, hash: receipt.hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, status: receipt.status });
      progress('confirmed', { id, hash: receipt.hash, blockNumber: receipt.blockNumber });
      return receipt;
    }
    async function creationNonce(signer) {
      const nonce = await provider.getTransactionCount(signer.address, 'pending');
      const cursor = await recovery.read(sdk.recoveryAccountKey(15000, signer.address));
      if (cursor?.blockedBy || (cursor && cursor.nextNonce > nonce)) fail('Account recovery or pending nonce must settle before another creation.', 'RECOVERY_BLOCKED');
      return nonce;
    }
    async function nativeCreate(id, signer, creation, onSubmitted = async () => {}) {
      progress('creation', { id, expectedAddress: creation.expectedAddress });
      let saved = await evidence.get(`creation:${id}`);
      const intent = { chainId: 15000, from: signer.address, nonce: creation.quaiCreation.nonce, data: creation.creationData, expectedAddress: creation.expectedAddress };
      if (saved && evidenceHash(saved.intent) !== evidenceHash(intent)) fail('Creation intent differs from persisted evidence.');
      const accountKey = sdk.recoveryAccountKey(15000, signer.address);
      let cursor = await recovery.read(accountKey);
      if (!saved) {
        if (cursor?.blockedBy && cursor.blockedBy !== id) fail('Another account operation is unresolved.', 'RECOVERY_BLOCKED');
        if (cursor && cursor.nextNonce > intent.nonce && cursor.blockedBy !== id) fail('Creation nonce is below the durable account floor.', 'PLAN_CHANGED');
        if (await provider.getTransactionCount(signer.address, 'pending') !== intent.nonce) fail('Native CREATE nonce changed before signing.', 'PLAN_CHANGED');
        if (cursor?.blockedBy !== id) {
          const reserved = { version: 1, kind: 'nonce', id: accountKey, revision: (cursor?.revision ?? -1) + 1, chainId: 15000, from: sdk.address(signer.address), nextNonce: intent.nonce + 1, blockedBy: id };
          if (!await recovery.compareAndSwap(accountKey, cursor?.revision ?? null, reserved)) fail('Creation nonce reservation raced another worker.', 'RECOVERY_CONFLICT');
          cursor = reserved;
        }
        const request = await signer.populateQuaiTransaction({ from: signer.address, chainId: 15000n, nonce: intent.nonce, data: intent.data, value: 0n });
        request.gasLimit = (BigInt(request.gasLimit) * 120n + 99n) / 100n;
        await checkBudget(request);
        const signed = await signer.signTransaction(request), hash = QuaiTransaction.from(signed).hash;
        saved = { intent, hash, status: 'signed' };
        await evidence.put(`creation:${id}`, saved);
        // Keep independent signed-hash evidence before broadcasting; this is not a submission acknowledgment.
        const sent = await provider.broadcastTransaction(Zone.Cyprus1, signed);
        progress('submitted-creation', { id, hash: sent.hash });
        if (sent.hash.toLowerCase() !== hash.toLowerCase()) fail('Provider returned a different creation transaction hash.', 'INVALID_RESPONSE');
        await onSubmitted(hash);
      } else {
        const observed = await provider.getTransaction(saved.hash);
        if (!observed) fail('Signed creation hash has no independent submission evidence; never automatically resend.', 'TX_PENDING');
        if (observed.hash.toLowerCase() !== saved.hash.toLowerCase() || observed.chainId !== 15000n || !same(observed.from, signer.address) || observed.nonce !== intent.nonce
          || observed.to != null || observed.data.toLowerCase() !== intent.data.toLowerCase() || observed.value !== 0n) fail('Observed creation does not match the journal.', 'INVALID_RESPONSE');
        await onSubmitted(saved.hash);
      }
      const receipt = await confirmed(saved.hash);
      const tx = await provider.getTransaction(saved.hash), block = await provider.getBlock(Shard.Cyprus1, receipt.blockNumber);
      if (!tx || tx.hash.toLowerCase() !== saved.hash.toLowerCase() || receipt.hash.toLowerCase() !== saved.hash.toLowerCase() || tx.chainId !== 15000n || !same(tx.from, signer.address) || tx.nonce !== intent.nonce || tx.to != null || tx.data.toLowerCase() !== intent.data.toLowerCase()
        || tx.value !== 0n || receipt.blockHash !== block?.hash || !receipt.contractAddress || !same(receipt.contractAddress, intent.expectedAddress)) fail('Native creation evidence differs from signed intent.', 'INVALID_RESPONSE');
      cursor = await recovery.read(accountKey);
      if (cursor?.blockedBy === id && !await recovery.compareAndSwap(accountKey, cursor.revision, { ...cursor, revision: cursor.revision + 1, blockedBy: null })) fail('Creation account release raced another worker.', 'RECOVERY_CONFLICT');
      await evidence.put(`creation:${id}`, { ...saved, status: 'verified', receipt: { hash: receipt.hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, contractAddress: receipt.contractAddress } });
      progress('confirmed-creation', { id, hash: receipt.hash, contractAddress: receipt.contractAddress });
      return receipt;
    }
    async function auxiliary(name, args, source) {
      const id = `auxiliary/${name}`;
      let plan = await evidence.get(id);
      if (!plan) {
        const artifact = await sourceArtifact(contractsRoot, name, source);
        const data = artifact.bytecode + new Interface(artifact.abi).encodeDeploy(args).slice(2);
        plan = await grindCreation(owner.address, await creationNonce(owner), data);
        await evidence.put(id, plan);
      }
      await nativeCreate(id, owner, plan);
      return plan.expectedAddress;
    }
    async function existingVault(route) {
      const id = `vault/${route}`;
      let plan = await evidence.get(id);
      const factory = new sdk.ContractClient('QuaiVaultFactory', config.deployment.quaiVaultFactory, provider);
      if (!plan) {
        const init = new sdk.ContractClient('QuaiVault', config.deployment.vaultSingleton).interface.encodeFunctionData('initialize', [[owner.address], 1n, 0n, [], []]);
        const initCodeHash = keccak256(concat([proxy.bytecode, AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [config.deployment.vaultSingleton, init])]));
        const mined = await sdk.mineLaunchSalt({ factory: factory.address, sender: owner.address, initCodeHash, startSalt: config.saltStart + (route === 'direct' ? 0n : 1000000n) });
        const predicted = await factory.read('predictWalletAddress', [owner.address, mined.saltHex, [owner.address], 1n, 0n, [], []]);
        if (!same(predicted, mined.address)) fail('Vault proxy bytecode does not match the deployed factory prediction.');
        plan = { address: predicted, call: factory.encode('createWallet(address[],uint256,bytes32,uint32,address[],address[])', [[owner.address], 1n, mined.saltHex, 0n, [], []]) };
        await evidence.put(id, plan);
      }
      await send(id, plan.call, owner);
      const vault = new sdk.ContractClient('QuaiVault', plan.address, provider);
      if (!await vault.read('isOwner', [owner.address]) || await vault.read('threshold', []) !== 1n || await vault.read('minExecutionDelay', []) !== 0n) fail('Existing-vault fixture owner policy differs from the acceptance scenario.');
      return plan.address;
    }
    const initial = { multisendLibrary: config.deployment.multisendCallOnly,
      governanceConfig: { votingPeriod: 180, gracePeriod: 0, proposalOffering: 0n, quorumPercent: 1000n, sponsorThreshold: 1n, minRetentionPercent: 0n, defaultExpiryWindow: 3600 },
      navigators: [], navigatorPermissions: [], initMembers: [owner.address, member.address], initShareAmounts: [1000n, 1000n], initLootAmounts: [0n, 0n],
      guildTokens: [ZeroAddress], pauseSharesOnLaunch: false, pauseLootOnLaunch: false };
    async function launchPlan(route, i) {
      const id = `plan/launch/${route}`; let plan = await evidence.get(id);
      if (plan) return plan;
      const existing = route === 'new-vault' ? undefined : await existingVault(route);
      const salts = await sdk.mineDAOShipSalts({ factory: config.deployment.daoShipLauncher, sender: route === 'direct' ? owner.address : config.deployment.daoShipAndVaultLauncher,
        singletons: { daoShip: config.deployment.daoShipSingleton, shares: config.deployment.sharesSingleton, loot: config.deployment.lootSingleton }, startSalt: config.saltStart + BigInt(i + 2) * 1000000n,
        ...(route === 'new-vault' ? { vault: { factory: config.deployment.quaiVaultFactory, proxyBytecode: proxy.bytecode, implementation: config.deployment.vaultSingleton, owners: [owner.address], threshold: 1n, multisendCallOnly: config.deployment.multisendCallOnly } } : {}) });
      plan = sdk.buildDAOShipLaunchPlan({ route, chainId: 15000, from: owner.address, deployment: config.deployment,
        parameters: { initialization: initial, shareTokenName: `Orchard ${route}`, shareTokenSymbol: 'OAS', lootTokenName: 'Orchard Loot', lootTokenSymbol: 'OAL', sharesSalt: salts.shares.salt, lootSalt: salts.loot.salt, daoShipSalt: salts.daoShip.salt },
        ...(route === 'new-vault' ? { vaultOwners: [owner.address], vaultThreshold: 1n, vaultSalt: salts.vault.salt, vaultProxyBytecode: proxy.bytecode } : { existingVault: existing }) });
      await evidence.put(id, plan); return plan;
    }
    async function signalFresh(plan, stage) {
      const start = (await evidence.get(`signal-start:${plan.id}`)).blockNumber;
      const latest = await provider.getBlock(Shard.Cyprus1, 'latest');
      if (latest.woHeader.number - start > 10000) fail('Signal endorsement scan exceeds its explicit 10000-block history bound.');
      const logs = await provider.getLogs({ nodeLocation: [0, 0], address: config.poster, fromBlock: start, toBlock: latest.woHeader.number,
        topics: [new Interface(sdk.CONTRACT_ABIS.Poster).getEvent('NewPost').topicHash] });
      logs.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
      if ((await provider.getBlock(Shard.Cyprus1, latest.woHeader.number))?.hash !== latest.hash) fail('Signal history changed during its read.', 'PLAN_CHANGED');
      const posts = sdk.parseContractEvents({ status: 1, logs }, 'Poster', config.poster, 'NewPost').filter(post => same(post.args.user, plan.vault)
        && post.args.tag.hash === sdk.posterTagTopic(sdk.POSTER_TAGS.DAO_NAVIGATORS));
      const own = posts.filter(post => { try { return same(JSON.parse(post.args.content).daoAddress, plan.daoShip); } catch { return false; } });
      return stage === 'before-activation' ? own.length === 0 : own.at(-1)?.args.content === plan.signalEndorsement.content;
    }
    const executors = {
      transaction: { async execute(plan, step, ctx) { const signer = same(plan.from, member.address) ? member : owner; return send(`${ctx.id}/transaction`, step.calls[0], signer, ctx.onSubmitted); } },
      creation: { execute: (plan, _step, ctx) => nativeCreate(ctx.id, same(plan.from, member.address) ? member : owner, plan, ctx.onSubmitted) },
      vault: { async execute(plan, step, ctx) {
        if (plan.type !== 'dao-launch') fail('Vault-owner executor is restricted to existing-vault bootstrap.');
        const client = new sdk.ContractClient('QuaiVault', plan.expected.vault, provider), call = step.calls[0];
        const proposed = await send(`${ctx.id}/propose`, client.encode('proposeTransaction(address,uint256,bytes)', [call.to, call.value, call.data]), owner);
        const proposal = sdk.parseContractEvents(proposed, 'QuaiVault', client.address, 'TransactionProposed')[0];
        if (!proposal) fail('Vault proposal event missing.', 'MISSING_EVENT');
        await send(`${ctx.id}/approve`, client.encode('approveTransaction', [proposal.args.txHash]), owner);
        const executed = await send(`${ctx.id}/execute`, client.encode('executeTransaction', [proposal.args.txHash]), owner, ctx.onSubmitted);
        return executed;
      } },
      'dao-governance': { async execute(plan, step, ctx) {
        const signer = same(plan.from, member.address) ? member : owner, client = new sdk.ContractClient('DAOShip', plan.daoShip, provider);
        if (plan.kind === 'BudgetNavigator' && await new sdk.ContractClient('QuaiVault', plan.vault, provider).read('isOwner', [signer.address])) fail('Budget acceptance requires a DAO member who is not a vault owner.');
        const executionId = await governanceExecutionId(evidence, ctx.id);
        const retry = await evidence.get(`governance-retry:${ctx.id}`);
        if (retry) {
          // A reviewed retry must identify a canonical prior proposal; closure below
          // authenticates its defeated outcome. Unknown broadcasts never select a retry.
          const previous = await sdk.inspectRecoveryTransaction(recovery, provider, retry.previousProposalTransactionId, options);
          requireMinedRecovery(previous);
          if (previous.record.hash !== retry.previousProposalHash || !same(previous.record.intent.to, plan.daoShip)
            || sdk.parseSubmitReceipt(await provider.getTransactionReceipt(previous.record.hash), plan.daoShip) !== retry.previousProposalId) fail('Governance retry differs from its reviewed proposal.', 'RECOVERY_BLOCKED');
          if (retry.previousVoteId) {
            const vote = await sdk.inspectRecoveryTransaction(recovery, provider, retry.previousVoteId, options);
            if (vote.outcome !== 'reverted' || vote.record.hash !== retry.previousVoteHash) fail('Governance retry lacks its reviewed canonical revert.', 'RECOVERY_BLOCKED');
          }
          const closed = await send(`${executionId}/close-defeated`, client.encode('processProposal', [BigInt(retry.previousProposalId), '0x']), signer);
          if (sdk.parseProcessReceipt(closed, plan.daoShip, retry.previousProposalId) !== 'defeated') fail('The prior failed-vote proposal did not close as defeated.', 'INVALID_RESPONSE');
        }
        // Act on the first canonical proposal receipt, then verify it at the configured
        // depth after voting. Waiting for extra blocks before voting can exhaust a 60s window.
        const proposed = await send(`${executionId}/propose`, client.encode('submitProposal', [step.proposalData, 0n, 'Orchard SDK acceptance']), signer, undefined, 1);
        const id = sdk.parseSubmitReceipt(proposed, plan.daoShip);
        const vote = client.encode('submitVote', [BigInt(id), true]);
        if (!await recovery.read(sdk.recoveryTransactionKey(`${executionId}/vote`))) {
          await waitForVotingSnapshot(() => chain.prepareCall(vote, signer.address), { timeoutMs: config.waitTimeoutMs });
        }
        await send(`${executionId}/vote`, vote, signer);
        requireMinedRecovery(await sdk.inspectRecoveryTransaction(recovery, provider, `${executionId}/propose`, options));
        // Chain timestamps can advance more slowly than wall time. Allow the full
        // fixture period plus the configured transport/confirmation wait budget.
        const deadline = performance.now() + (initial.governanceConfig.votingPeriod + initial.governanceConfig.gracePeriod) * 1000 + config.waitTimeoutMs;
        while (true) {
          const status = await chain.getProposal(plan.daoShip, id);
          if (status.state === sdk.ProposalState.Ready || status.state === sdk.ProposalState.Processed) break;
          if (![sdk.ProposalState.Voting, sdk.ProposalState.Grace].includes(status.state)) fail('Acceptance governance proposal did not reach an executable state.', 'PROPOSAL_STATE');
          if (performance.now() >= deadline) fail('Voting has not ended within this run; resume the persisted scenario.', 'TX_PENDING');
          await delay(3000);
        }
        const executed = await send(`${executionId}/process`, client.encode('processProposal', [BigInt(id), step.proposalData]), signer, ctx.onSubmitted);
        sdk.assertActionSucceeded(executed, plan.daoShip, id);
        return executed;
      } },
    };
    async function runPlan(plan) {
      progress('workflow', { kind: plan.kind ?? plan.route, id: plan.id });
      const settings = { ...options, ...(plan.type === 'navigator' && plan.kind === 'SignalNavigator' ? { verifyCurrentSignalEndorsement: signalFresh } : {}) };
      for (let count = 0; count <= plan.steps.length; count++) {
        const before = await workflow.load(plan.id);
        try {
          const checkpoint = await sdk.advanceDeploymentWorkflow(plan, workflow, executors, provider, settings);
          if (plan.steps.every(step => checkpoint.steps[step.id]?.status === 'verified')) { await evidence.put(`completed:${plan.id}`, checkpoint); progress('completed-workflow', { kind: plan.kind ?? plan.route, id: plan.id }); return; }
        } catch (error) {
          const step = plan.steps.find(item => before?.steps[item.id]?.status !== 'verified');
          // This exact runner can resume its intermediate transaction IDs: each send first
          // reconciles durable recovery evidence, and unknown attempts still block.
          if (errorCode(error) !== 'TX_PENDING' || error.details?.stepId !== step?.id || before.steps[step.id]?.status !== 'submitting') throw error;
          const executionId = `${plan.id}:${step.id}`;
          const finalId = step.kind === 'dao-governance' ? await governanceExecutionId(evidence, executionId) : executionId;
          const finalKey = step.kind === 'creation' ? null : `${finalId}/${({ transaction: 'transaction', vault: 'execute', 'dao-governance': 'process' })[step.kind]}`;
          const finalRecord = finalKey ? await recovery.read(sdk.recoveryTransactionKey(finalKey)) : await evidence.get(`creation:${executionId}`);
          if (finalRecord?.hash) {
            if (step.kind === 'creation') await nativeCreate(executionId, same(plan.from, member.address) ? member : owner, plan);
            else await confirmed(finalRecord.hash);
            await sdk.reconcileDeploymentWorkflowStep(plan, workflow, step.id, finalRecord.hash, provider, settings);
            continue;
          }
          const prepared = await sdk.prepareDeploymentWorkflowStep(plan, step.id, provider, settings);
          if (plan.kind === 'SignalNavigator' && !await signalFresh(plan, 'before-activation')) fail('Signal endorsement changed while governance was pending.', 'PLAN_CHANGED');
          const receipt = await executors[step.kind].execute(plan, step, { id: `${plan.id}:${step.id}`, prepared,
            async onSubmitted(hash) {
              const current = await workflow.load(plan.id), entry = current.steps[step.id];
              if (!['submitting', 'submitted'].includes(entry.status) || (entry.hash && entry.hash !== hash)) fail('Workflow execution hash changed during resume.');
              const next = { ...current, revision: current.revision + 1, steps: { ...current.steps, [step.id]: { status: 'submitted', hash } } };
              if (!await workflow.compareAndSwap(plan.id, current.revision, next)) fail('Workflow checkpoint changed during resume.');
            } });
          await sdk.reconcileDeploymentWorkflowStep(plan, workflow, step.id, receipt.hash, provider, settings);
        }
      }
      fail('Workflow did not converge within its bounded step count.');
    }
    let daoPlan;
    for (const [i, route] of ['direct', 'existing-vault', 'new-vault'].entries()) { const plan = await launchPlan(route, i); await runPlan(plan); if (route === 'new-vault') daoPlan = plan; }
    // Older evidence retains its original 60s launch plan. Upgrade that disposable
    // governance fixture through a real member proposal, preserving historical receipts.
    const windowKey = 'fixture/governance-window', currentDao = await chain.getDao(daoPlan.expected.daoShip);
    let windowPlan = await evidence.get(windowKey);
    if (currentDao.votingPeriod < 180n || windowPlan) {
      const expected = { id: `${daoPlan.id}:governance-window`, kind: 'governance-window', from: member.address,
        daoShip: daoPlan.expected.daoShip, config: initial.governanceConfig,
        proposalData: sdk.encodeProposal([sdk.buildGovernanceAction(daoPlan.expected.daoShip, { method: 'setGovernanceConfig', config: initial.governanceConfig })]) };
      if (windowPlan && evidenceHash(windowPlan) !== evidenceHash(expected)) fail('Governance window plan changed.', 'PLAN_CHANGED');
      if (!windowPlan) { windowPlan = expected; await evidence.put(windowKey, windowPlan); }
      let completed = await evidence.get(`${windowKey}/completed`);
      if (!completed) {
        progress('governance-window', { seconds: 180 });
        const receipt = await executors['dao-governance'].execute(windowPlan, windowPlan, { id: windowPlan.id, onSubmitted: async () => {} });
        completed = { hash: receipt.hash, blockNumber: receipt.blockNumber, proposalId: Number(sdk.parseContractEvents(receipt, 'DAOShip', windowPlan.daoShip, 'ProcessProposal')[0].args.proposal) };
        await evidence.put(`${windowKey}/completed`, completed);
      }
      const receipt = await confirmed(completed.hash);
      sdk.assertActionSucceeded(receipt, windowPlan.daoShip, completed.proposalId);
      const current = await chain.getDao(windowPlan.daoShip);
      for (const [key, value] of Object.entries(windowPlan.config)) if (BigInt(current[key]) !== BigInt(value)) fail('Governance window update did not match its configuration.', 'INVALID_RESPONSE');
    }
    const tribute = await auxiliary('MockERC20', ['Orchard Tribute', 'OT'], 'contracts/test/MockERC20.sol');
    const nft = await auxiliary('MockERC721', [], 'contracts/test/MockERC721.sol');
    const base = { daoShip: daoPlan.expected.daoShip, name: 'Orchard SDK acceptance', description: 'Dedicated testnet fixture' };
    const cap = { expiry: 0n, mintCap: 1000n, perAddressCap: 100n, allowlistRoot: ZeroHash };
    const configs = {
      OnboarderNavigator: { ...base, ...cap, shareMultiplier: 10000n, lootMultiplier: 0n, pricePerUnit: 0n, sharesPerUnit: 0n, lootPerUnit: 0n, minTribute: 1n },
      ERC20TributeNavigator: { ...base, ...cap, tributeToken: tribute, pricePerShare: 10n ** 18n, pricePerLoot: 0n },
      NFTGatedNavigator: { ...base, ...cap, gateToken: nft, sharesPerHolder: 1n, lootPerHolder: 0n, requireTribute: false, tributeAmount: 0n },
      SignalNavigator: { ...base, minSharesToCreatePoll: 1n, minDuration: 60n, maxDuration: 3600n, maxStartDelay: 3600n },
      TimelockNavigator: { ...base, delay: 600n, expiryWindow: 3600n }, VestingNavigator: base, BudgetNavigator: base,
      SubscriptionNavigator: { ...base, tokens: [ZeroAddress], feesPerPeriod: [1n], periodDuration: 3600n, graceDuration: 60n, startTime: 0n, collectorRewardBps: 0n, burnOnCollect: false, initialMembers: [] },
    };
    for (const kind of sdk.NAVIGATOR_KINDS) {
      const key = `plan/navigator/${kind}`; let plan = await evidence.get(key);
      if (!plan) {
        const signer = kind === 'BudgetNavigator' ? member : owner;
        const grinded = await grindCreation(signer.address, await creationNonce(signer), sdk.encodeNavigatorDeployment(kind, NAVIGATOR_BYTECODES[kind], configs[kind]));
        plan = sdk.buildNavigatorDeploymentPlan({ chainId: 15000, from: signer.address, kind, config: configs[kind], bytecode: NAVIGATOR_BYTECODES[kind],
          expectedAddress: grinded.expectedAddress, quaiCreation: grinded.quaiCreation, vault: daoPlan.expected.vault,
          ...(kind === 'SignalNavigator' ? { signalEndorsement: { poster: config.poster, currentNavigators: [] } } : {}) });
        if (kind === 'SignalNavigator') await evidence.put(`signal-start:${plan.id}`, { blockNumber: startup.discovered.blockNumber });
        await evidence.put(key, plan);
      }
      await runPlan(plan);
    }
    const recoveryScenarios = await runOrchardRecoveryScenarios({ chain, provider, signer: boundedSigner(owner), store: recovery, evidence, confirmations: config.confirmations, timeoutMs: config.waitTimeoutMs });
    progress('indexer-fixtures');
    const indexed = await verifyIndexedOrchardFixtures({ evidence, provider, timeoutMs: config.waitTimeoutMs });
    const report = { status: 'completed', chainId: 15000, dependency: 'quais@1.0.0-alpha.53', configurationHash: configHash, recoveryScenarios,
      indexer: { matched: indexed.matched, targetBlock: indexed.targetBlock, daoRows: indexed.launches.length, navigatorRows: indexed.navigators.length },
      scenarios: { daoLaunches: 3, navigatorActivations: 8, budgetActivatedByNonOwner: true },
      completedAt: new Date().toISOString(), limitations: ['Receipt depth is not a finality proof.', 'Acknowledgement loss is injected after a real transfer. Replacement races and process-crash conformance require separate evidence.'] };
    await evidence.put('report', report); return report;
  } catch (error) {
    const failure = { code: errorCode(error), stage: currentStage, ...(error instanceof sdk.DaoShipsError ? { message: error.message } : {}), at: new Date().toISOString() };
    await evidence.put('last-failure', failure);
    progress('stopped', { ...failure, stage: 'stopped', failedStage: failure.stage });
    throw new sdk.DaoShipsError(errorCode(error), 'Orchard acceptance stopped. Inspect public evidence and the documented recovery procedure.');
  } finally { await unlock(); provider.destroy(); }
}
