import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, Shard } from 'quais';
import { DaoShipsChain, ProposalState } from '../dist/chain.js';
import { CONTRACT_ABIS } from '../dist/abis.js';
import { ContractClient } from '../dist/contracts.js';
import { parseTokenAmount, formatTokenAmount, buildPermitTypedData } from '../dist/tokens.js';
import { sendPreparedTransaction, confirmTransaction } from '../dist/transactions.js';
const DAO = '0x0011111111111111111111111111111111111111';
const MEMBER = '0x0022222222222222222222222222222222222222';
const SHARES = '0x0033333333333333333333333333333333333333';
const LOOT = '0x0044444444444444444444444444444444444444';
const VAULT = '0x0055555555555555555555555555555555555555';
const TX = '0x' + '11'.repeat(32);
const dao = new Interface(CONTRACT_ABIS.DAOShip), token = new Interface(CONTRACT_ABIS.SharesERC20);
function chainFixture(options = {}) {
  const calls = [], balances = [];
  const provider = {
    async getNetwork() { return { chainId: 9n }; },
    async getBlock(shard) { assert.equal(shard, Shard.Cyprus1); return { hash: TX, woHeader: { number: 123, timestamp: 1000 } }; },
    async getBalance(who, block) { balances.push([who, block]); if (options.nativeError) throw new Error('network unavailable'); return 1n << 200n; },
    async call(request) {
      calls.push(request); assert.equal(request.blockTag, 123);
      const iface = request.to === DAO ? dao : token;
      const parsed = iface.parseTransaction(request);
      const values = {
        avatar: [VAULT], sharesToken: [SHARES], lootToken: [LOOT], votingPeriod: [60n], gracePeriod: [0n], proposalOffering: [1n << 180n],
        quorumPercent: [5000n], sponsorThreshold: [1n], minRetentionPercent: [0n], defaultExpiryWindow: [120n],
        adminLock: [true], managerLock: [false], governorLock: [true],
        getGuildTokens: [[SHARES, ZeroAddress]], balanceOf: [request.to === SHARES ? 123n : 456n], getCurrentVotes: [789n], delegates: [MEMBER],
        navigators: [7n], isAdmin: [true], isManager: [true], isGovernor: [true],
        state: [options.state ?? ProposalState.Voting], getProposalStatus: [[false, false, false, false]],
      }[parsed.name];
      if (values) return iface.encodeFunctionResult(parsed.name, values);
      if (options.simulationReverts) throw new Error('execution reverted');
      return '0x';
    },
  };
  return { provider, calls, balances, chain: new DaoShipsChain(provider, 9) };
}
test('DAO, member, capability and treasury reads preserve bigint and pin dependent calls', async () => {
  const f = chainFixture();
  const config = await f.chain.getDao(DAO);
  assert.equal(config.proposalOffering, 1n << 180n); assert.equal(config.adminLocked, true); assert.equal(config.managerLocked, false);
  const member = await f.chain.getMember(DAO, MEMBER);
  assert.deepEqual([member.shares, member.loot, member.votingPower, member.delegate], [123n, 456n, 789n, MEMBER]);
  const caps = await f.chain.getCapabilities(DAO, MEMBER); assert.equal(caps.permissions, 7n);
  const treasury = await f.chain.getTreasury(DAO);
  assert.deepEqual(treasury.tokens, [{ address: SHARES, balance: 123n }, { address: ZeroAddress, balance: 1n << 200n }]);
  assert.deepEqual(f.balances, [[VAULT, 123]]);
  assert.ok(f.calls.every(call => call.blockTag === 123));
  assert.ok(f.calls.every(call => call.from === ZeroAddress), 'view calls must not use a contract as their sender');
});
test('native treasury provider failure has a stable SDK error', async () => {
  await assert.rejects(chainFixture({ nativeError: true }).chain.getTreasury(DAO), { code: 'CHAIN_ERROR' });
});
test('batch votes preflight every state and simulate exact parallel arrays', async () => {
  const f = chainFixture();
  const votes = [{ proposalId: 1, approved: true }, { proposalId: 3, approved: false }];
  const p = await f.chain.prepareVotes(DAO, votes, MEMBER);
  assert.equal(p.from, MEMBER); assert.equal(p.value, 0n);
  const d = dao.decodeFunctionData('submitVotes', p.data);
  assert.deepEqual([...d[0]], [1n, 3n]); assert.deepEqual([...d[1]], [true, false]);
  assert.equal(f.calls.filter(call => dao.parseTransaction(call).name === 'state').length, 2);
  await assert.rejects(f.chain.prepareVotes(DAO, [votes[0], votes[0]], MEMBER), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(chainFixture({ state: ProposalState.Grace }).chain.prepareVotes(DAO, votes, MEMBER), { code: 'PROPOSAL_STATE' });
});
test('ragequit keeps explicit withdrawal selection and sorts native plus ERC20 addresses', async () => {
  const f = chainFixture();
  const p = await f.chain.prepareRagequit(DAO, MEMBER, MEMBER, 10n, 20n, [LOOT, ZeroAddress, SHARES]);
  const decoded = dao.decodeFunctionData('ragequit', p.data);
  assert.deepEqual([...decoded[3]], [ZeroAddress, SHARES, LOOT]);
  assert.equal(f.calls.at(-1).from, MEMBER);
  await assert.rejects(f.chain.prepareRagequit(DAO, MEMBER, MEMBER, 0n, 0n, []), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(f.chain.prepareRagequit(DAO, MEMBER, MEMBER, 1n, 0n, [SHARES, SHARES]), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(chainFixture({ simulationReverts: true }).chain.prepareRagequit(DAO, MEMBER, MEMBER, 1n, 0n, [SHARES]), { code: 'CHAIN_ERROR' });
});
function sendFixture() {
  const prepared = { chainId: 9, from: MEMBER, to: DAO, data: dao.encodeFunctionData('cancelProposal', [1]), value: 0n, operation: 'cancelProposal', checkedAt: { blockNumber: 123, blockHash: TX } };
  const sent = [], events = [];
  const signer = {
    provider: { async getNetwork() { return { chainId: 9n }; } },
    async getAddress() { return MEMBER; },
    async estimateGas() { events.push('estimate'); return 101n; },
    async sendTransaction(request) { events.push('broadcast'); sent.push(request); return { hash: TX }; },
  };
  const options = { async refresh() { events.push('refresh'); return prepared; }, async onSubmitted(record) { events.push('persist'); assert.equal(record.hash, TX); } };
  return { prepared, sent, events, signer, options };
}
test('send refreshes, validates signer/network, estimates once and persists broadcast hash', async () => {
  const f = sendFixture();
  const tx = await sendPreparedTransaction(f.prepared, f.signer, f.options);
  assert.equal(tx.hash, TX); assert.deepEqual(f.events, ['refresh','estimate','broadcast','persist']);
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].gasLimit, 122n); assert.equal(f.sent[0].chainId, 9n);
  for (const [patch, code] of [[{ value: 1n }, 'PLAN_CHANGED'], [{ data: '0x' }, 'PLAN_CHANGED']]) {
    const changed = sendFixture();
    await assert.rejects(sendPreparedTransaction(changed.prepared, changed.signer, { ...changed.options, refresh: async () => ({ ...changed.prepared, ...patch }) }), { code });
    assert.equal(changed.sent.length, 0);
  }
  const wrongSigner = sendFixture(); wrongSigner.signer.getAddress = async () => DAO;
  await assert.rejects(sendPreparedTransaction(wrongSigner.prepared, wrongSigner.signer, wrongSigner.options), { code: 'SIGNER_MISMATCH' });
  const wrongNetwork = sendFixture(); wrongNetwork.signer.provider.getNetwork = async () => ({ chainId: 15000n });
  await assert.rejects(sendPreparedTransaction(wrongNetwork.prepared, wrongNetwork.signer, wrongNetwork.options), { code: 'CHAIN_MISMATCH' });
});
test('post-broadcast persistence failure exposes hash and never resends', async () => {
  const f = sendFixture();
  await assert.rejects(sendPreparedTransaction(f.prepared, f.signer, { ...f.options, onSubmitted() { throw new Error('disk full'); } }), error => error.code === 'PERSISTENCE_ERROR' && error.details.hash === TX);
  assert.equal(f.sent.length, 1);
});
test('confirmation preserves pending uncertainty, validates receipt and bounds provider wait lifetime', async () => {
  let args;
  const receipt = { status: 1, logs: [] };
  assert.equal(await confirmTransaction({ hash: TX, async wait(...passed) { args = passed; return receipt; } }, { confirmations: 2, timeoutMs: 1000 }), receipt);
  assert.deepEqual(args, [2, 1000]);
  await assert.rejects(confirmTransaction({ hash: TX, wait: async () => ({ status: 0, logs: [] }) }), { code: 'TX_REVERTED' });
  await assert.rejects(confirmTransaction({ hash: TX, wait: async () => { throw { receipt: { status: 0, logs: [] } }; } }), { code: 'TX_REVERTED' });
  await assert.rejects(confirmTransaction({ hash: TX, wait: async () => null }), { code: 'TX_PENDING' });
  const controller = new AbortController(); controller.abort();
  let waited = false;
  await assert.rejects(confirmTransaction({ hash: TX, wait: async () => { waited = true; return receipt; } }, { signal: controller.signal }), { code: 'TX_PENDING' });
  assert.equal(waited, false);
  await assert.rejects(confirmTransaction({ hash: TX, wait: async () => new Promise(() => {}) }, { timeoutMs: 1 }), { code: 'TX_PENDING' });
});
test('all ERC20 uint8 precisions parse and format without FixedNumber limits', () => {
  const smallest = '0.' + '0'.repeat(254) + '1';
  assert.equal(parseTokenAmount(smallest, 255), 1n);
  assert.equal(formatTokenAmount(1n, 255), smallest);
  assert.equal(parseTokenAmount('9007199254740993.123456789012345678', 18), 9007199254740993123456789012345678n);
  for (const text of ['1e18','-1','NaN','1.001']) assert.throws(() => parseTokenAmount(text, 2), { code: 'INVALID_ARGUMENT' });
});
test('generic contract access exposes vault setup methods and rejects value on nonpayable calls', () => {
  const vault = new ContractClient('QuaiVault', VAULT);
  assert.equal(vault.interface.parseTransaction(vault.encode('enableModule', [DAO])).name, 'enableModule');
  assert.equal(vault.interface.parseTransaction(vault.encode('addDelegatecallTarget', [SHARES])).name, 'addDelegatecallTarget');
  assert.throws(() => vault.encode('enableModule', [DAO], { value: 1n }), { code: 'INVALID_ARGUMENT' });
  const permit = buildPermitTypedData({ token: SHARES, name: 'DAO Shares', chainId: 9n, owner: MEMBER, spender: DAO, value: 1n << 180n, nonce: 7n, deadline: 10000n });
  assert.equal(permit.domain.verifyingContract, SHARES); assert.equal(permit.domain.version, '1'); assert.equal(permit.value.nonce, 7n);
});

test('batch preparation bounds RPC concurrency and rejects oversized or accessor inputs before reads', async () => {
  const f = chainFixture(); let active = 0, peak = 0;
  const provider = { ...f.provider, async call(request) {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1));
    try { return await f.provider.call(request); } finally { active--; }
  } };
  const votes = Array.from({ length: 25 }, (_, i) => ({ proposalId: i + 1, approved: i % 2 === 0 }));
  const prepared = await new DaoShipsChain(provider, 9).prepareVotes(DAO, votes, MEMBER);
  assert.equal(peak, 16);
  assert.equal(dao.decodeFunctionData('submitVotes', prepared.data)[0].length, 25);
  const untouched = new DaoShipsChain({ getNetwork() { throw Error('Unexpected RPC'); } }, 9);
  const accessor = [{ get proposalId() { throw Error('Unexpected accessor'); }, approved: true }];
  const sparse = Array(2); sparse[1] = votes[0];
  for (const input of [null, Array(1001), sparse, accessor, [null], [1]]) {
    await assert.rejects(untouched.prepareVotes(DAO, input, MEMBER), { code: 'INVALID_ARGUMENT' });
  }
  for (const input of [null, Array(21), Array(1)]) {
    await assert.rejects(untouched.prepareRagequit(DAO, MEMBER, MEMBER, 1n, 0n, input), { code: 'INVALID_ARGUMENT' });
  }
});
