import assert from 'node:assert/strict';
import * as sdk from '../../dist/index.js';
import { governanceExecutionId } from './support.mjs';

/** Match this run's public rows to its verified receipts, after the indexer catches up. */
export async function verifyIndexedOrchardFixtures({ evidence, provider, indexer: suppliedIndexer, timeoutMs = 60000 }) {
  const launches = [], navigators = [];
  for (const route of ['direct', 'existing-vault', 'new-vault']) {
    const plan = await evidence.get(`plan/launch/${route}`);
    assert.ok(plan, `Missing ${route} launch evidence.`);
    launches.push({ plan, receipt: await evidence.get(`receipt:${plan.id}:launch/transaction`) });
  }
  for (const kind of sdk.NAVIGATOR_KINDS) {
    const plan = await evidence.get(`plan/navigator/${kind}`);
    assert.ok(plan, `Missing ${kind} plan.`);
    const completed = await evidence.get(`completed:${plan.id}`);
    assert.ok(plan.steps.every(step => completed?.steps[step.id]?.status === 'verified'), `${kind} is not verified.`);
    const execution = await governanceExecutionId(evidence, `${plan.id}:activate`);
    navigators.push({ plan, execution, receipt: await provider.getTransactionReceipt(completed.steps.activate.hash) });
  }
  const target = Math.max(...launches.map(item => item.receipt.blockNumber), ...navigators.map(item => item.receipt.blockNumber));
  const indexer = suppliedIndexer ?? (await sdk.connectDaoShipsSupabase({ network: 'testnet' })).indexer;
  await indexer.waitForIndexedBlock(BigInt(target), { chainId: 15000, timeoutMs });
  const accounts = await evidence.get('accounts'), launchResults = [], navigatorResults = [], defeated = [];
  for (const { plan, receipt } of launches) {
    const row = await indexer.getDaoDetails(plan.expected.daoShip);
    assert.ok(row, `Missing indexed ${plan.route} DAO.`);
    for (const [field, expected] of Object.entries({ avatar: plan.expected.vault, shares_address: plan.expected.shares,
      loot_address: plan.expected.loot, deployer: accounts.owner, tx_hash: receipt.hash })) assert.equal(row[field]?.toLowerCase(), expected.toLowerCase(), `${plan.route}: ${field}`);
    assert.equal(row.total_shares, '2000'); assert.equal(row.total_loot, '0');
    for (const account of Object.values(accounts)) {
      const member = await indexer.getMember(plan.expected.daoShip, account);
      assert.equal(member?.shares, '1000'); assert.equal(member.loot, '0');
    }
    const result = { route: plan.route, dao: row.id, hash: receipt.hash, members: 2, matched: true };
    await evidence.put(`indexer-launch/${plan.route}`, result); launchResults.push(result);
  }
  for (const { plan, execution, receipt } of navigators) {
    const creation = await evidence.get(`creation:${plan.id}:create`);
    const proposed = await evidence.get(`receipt:${execution}/propose`), voted = await evidence.get(`receipt:${execution}/vote`);
    const events = sdk.parseContractEvents(receipt, 'DAOShip', plan.daoShip, 'ProcessProposal');
    assert.equal(events.length, 1);
    const id = Number(events[0].args.proposal);
    const [row, proposal, vote] = await Promise.all([indexer.getNavigator(plan.daoShip, plan.expectedAddress),
      indexer.getProposalDetails(plan.daoShip, id), indexer.getVote(plan.daoShip, id, plan.from)]);
    assert.ok(row, `Missing indexed ${plan.kind}.`);
    const required = sdk.getNavigatorRequirements(plan.kind);
    // NavigatorSet moves tx_hash to the grant; deployment identity remains in deploy_block.
    assert.equal(row.navigator_type, plan.kind);
    assert.equal(row.tx_hash, required.daoPermission ? receipt.hash : creation.hash);
    assert.equal(row.deploy_block, String(creation.receipt.blockNumber));
    assert.equal(row.deployer, plan.from.toLowerCase());
    assert.equal(row.trust_status, 'sanctioned'); assert.equal(row.is_active, true);
    assert.equal(row.permission, Number(required.daoPermission));
    assert.equal(proposal?.tx_hash, proposed.hash); assert.equal(proposal.process_tx_hash, receipt.hash);
    assert.equal(proposal.processed, true); assert.equal(proposal.passed, true); assert.equal(proposal.action_failed, false);
    assert.equal(proposal.yes_balance, '1000'); assert.equal(proposal.no_balance, '0');
    assert.equal(proposal.proposal_data_hash, sdk.hashProposalData(plan.steps.find(step => step.id === 'activate').proposalData));
    assert.equal(vote?.tx_hash, voted.hash); assert.equal(vote.approved, true); assert.equal(vote.balance, '1000');
    if (plan.kind === 'SignalNavigator') {
      const records = await indexer.listRecords(plan.daoShip, { filters: { tx_hash: receipt.hash } });
      assert.ok(records.items.some(record => record.user_address === plan.vault.toLowerCase()
        && record.tag === sdk.POSTER_TAGS.DAO_NAVIGATORS && record.content === plan.signalEndorsement.content), 'Missing vault-authored Signal endorsement.');
    }
    navigatorResults.push({ kind: plan.kind, address: row.navigator_address, proposalId: id,
      creationHash: creation.hash, proposalHash: proposed.hash, voteHash: voted.hash, activationHash: receipt.hash,
      permission: row.permission, trustStatus: row.trust_status, active: row.is_active });
    const retry = await evidence.get(`governance-retry:${plan.id}:activate`);
    for (const prior of retry ? [...(retry.history ?? []), retry] : []) {
      const failed = await indexer.getProposalDetails(plan.daoShip, prior.previousProposalId);
      const close = await evidence.get(`receipt:${plan.id}:activate/attempt-${prior.attempt}/close-defeated`);
      assert.equal(failed?.process_tx_hash, close.hash); assert.equal(failed.processed, true);
      assert.equal(failed.passed, false); assert.equal(failed.action_failed, false); assert.equal(failed.yes_balance, '0');
      defeated.push({ proposalId: prior.previousProposalId, processHash: close.hash, passed: false });
    }
  }
  const result = { matched: true, targetBlock: target, launches: launchResults, navigators: navigatorResults,
    defeatedProposals: defeated, observedAt: new Date().toISOString() };
  await evidence.put('indexer-navigators', result);
  return result;
}
