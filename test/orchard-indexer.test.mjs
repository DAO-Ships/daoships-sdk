import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import * as sdk from '../dist/index.js';
import { verifyIndexedOrchardFixtures } from '../scripts/orchard/indexer.mjs';

const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
function fixture() {
  const values = new Map(), daos = new Map(), rows = new Map(), receipts = new Map(), proposals = new Map(), votes = new Map();
  const owner = address(1), member = address(2), vault = address(3), iface = new Interface(sdk.CONTRACT_ABIS.DAOShip);
  values.set('accounts', { owner, member });
  let dao;
  for (const [i, route] of ['direct', 'existing-vault', 'new-vault'].entries()) {
    dao = address(10 + i);
    const expected = { daoShip: dao, vault, shares: address(20 + i), loot: address(30 + i) };
    values.set(`plan/launch/${route}`, { id: route, route, expected });
    values.set(`receipt:${route}:launch/transaction`, { hash: hash(i + 1), blockNumber: i + 1 });
    daos.set(dao, { id: dao, avatar: vault, shares_address: expected.shares, loot_address: expected.loot, deployer: owner,
      tx_hash: hash(i + 1), total_shares: '2000', total_loot: '0' });
  }
  let endorsement;
  for (const [i, kind] of sdk.NAVIGATOR_KINDS.entries()) {
    const id = i + 1, navigator = address(100 + id), created = hash(100 + id), proposed = hash(200 + id), voted = hash(300 + id), processed = hash(400 + id);
    const from = kind === 'BudgetNavigator' ? member : owner;
    const plan = { id: kind, kind, daoShip: dao, vault, from, expectedAddress: navigator,
      steps: [{ id: 'create' }, { id: 'activate', proposalData: '0x1234' }], signalEndorsement: { content: 'complete set' } };
    values.set(`plan/navigator/${kind}`, plan);
    values.set(`completed:${kind}`, { steps: { create: { status: 'verified' }, activate: { status: 'verified', hash: processed } } });
    values.set(`creation:${kind}:create`, { hash: created, receipt: { blockNumber: id } });
    values.set(`receipt:${kind}:activate/propose`, { hash: proposed });
    values.set(`receipt:${kind}:activate/vote`, { hash: voted });
    const event = iface.encodeEventLog(iface.getEvent('ProcessProposal'), [BigInt(id), true, false, from]);
    receipts.set(processed, { hash: processed, status: 1, blockNumber: 10 + id, logs: [{ address: dao, ...event }] });
    rows.set(navigator, { navigator_address: navigator, navigator_type: kind, tx_hash: sdk.getNavigatorRequirements(kind).daoPermission ? processed : created, deploy_block: String(id), deployer: from,
      permission: Number(sdk.getNavigatorRequirements(kind).daoPermission), trust_status: 'sanctioned', is_active: true });
    proposals.set(id, { tx_hash: proposed, process_tx_hash: processed, processed: true, passed: true, action_failed: false,
      yes_balance: '1000', no_balance: '0', proposal_data_hash: sdk.hashProposalData('0x1234') });
    votes.set(id, { tx_hash: voted, approved: true, balance: '1000' });
    if (kind === 'SignalNavigator') endorsement = { user_address: vault, tag: sdk.POSTER_TAGS.DAO_NAVIGATORS, content: plan.signalEndorsement.content };
  }
  const evidence = { get: async key => values.get(key) ?? null, put: async (key, value) => values.set(key, value) };
  const indexer = {
    async waitForIndexedBlock(target, options) { assert.equal(target, 18n); assert.equal(options.chainId, 15000); },
    async getDaoDetails(dao) { return daos.get(dao); }, async getMember() { return { shares: '1000', loot: '0' }; },
    async getNavigator(_dao, navigator) { return rows.get(navigator); }, async getProposalDetails(_dao, id) { return proposals.get(id); },
    async getVote(_dao, id) { return votes.get(id); }, async listRecords() { return { items: [endorsement] }; },
  };
  return { evidence, indexer, provider: { getTransactionReceipt: async hash => receipts.get(hash) }, values, rows, votes };
}

test('Orchard matches populated rows to receipts, including role-free Signal and Budget activations', async () => {
  const f = fixture(), result = await verifyIndexedOrchardFixtures(f);
  assert.equal(result.launches.length, 3); assert.equal(result.navigators.length, 8);
  assert.equal(result.navigators.find(row => row.kind === 'BudgetNavigator').permission, 0);
  assert.equal(f.values.get('indexer-navigators').matched, true);
});

test('A caught-up checkpoint cannot hide missing rows or stale deployment/grant/vote evidence', async () => {
  const missing = fixture(); missing.rows.delete(address(101));
  await assert.rejects(verifyIndexedOrchardFixtures(missing), /Missing indexed/);
  const wrongVote = fixture(); wrongVote.votes.get(1).tx_hash = hash(999);
  await assert.rejects(verifyIndexedOrchardFixtures(wrongVote), { code: 'ERR_ASSERTION' });
  assert.equal(wrongVote.values.has('indexer-navigators'), false);
  const staleGrant = fixture(); staleGrant.rows.get(address(101)).tx_hash = hash(101);
  await assert.rejects(verifyIndexedOrchardFixtures(staleGrant), { code: 'ERR_ASSERTION' });
  const wrongCreation = fixture(); wrongCreation.rows.get(address(101)).deploy_block = '999';
  await assert.rejects(verifyIndexedOrchardFixtures(wrongCreation), { code: 'ERR_ASSERTION' });
});
