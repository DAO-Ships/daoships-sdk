import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AbiCoder, Interface, keccak256, Shard } from 'quais';
import {
  DAO_SHIP_ABI, DaoShipsChain, DaoShipsIndexer, DaoShipsError, ProposalState,
  encodeProposal, governanceAction, hashProposalData, parseSubmitReceipt,
  parseProcessReceipt, assertActionSucceeded, stringify,
} from '../dist/index.js';

const DAO = '0x0011111111111111111111111111111111111111';
const WALLET = '0x0022222222222222222222222222222222222222';
const SHARES = '0x0033333333333333333333333333333333333333';
const LOOT = '0x0044444444444444444444444444444444444444';
const VAULT = '0x0055555555555555555555555555555555555555';
const iface = new Interface(DAO_SHIP_ABI);
const token = new Interface(['function totalSupply() view returns (uint256)']);
const vault = new Interface(['function isModuleEnabled(address module) view returns (bool)']);
const coder = AbiCoder.defaultAbiCoder();
const actionData = encodeProposal([{ to: WALLET, value: 1n, data: '0x' }]);
const hasCode = code => error => error instanceof DaoShipsError && error.code === code;

function provider(options = {}) {
  const calls = [];
  const instance = {
    calls,
    async getNetwork() { return { chainId: options.chainId ?? 15000n }; },
    async getBlock(shard, tag) {
      assert.equal(shard, Shard.Cyprus1); assert.ok(tag === 'latest' || tag === 42);
      return { hash: '0x' + 'aa'.repeat(32), woHeader: { number: 42, timestamp: '0x6553f100' } };
    },
    async call(tx) {
      calls.push(tx);
      assert.equal(tx.blockTag, 42);
      const contract = tx.to.toLowerCase() === VAULT ? vault
        : [SHARES, LOOT].includes(tx.to.toLowerCase()) ? token : iface;
      const parsed = contract.parseTransaction(tx);
      const name = parsed.name;
      if (name === 'totalSupply') return token.encodeFunctionResult(name, [options.supply ?? 100n]);
      if (name === 'isModuleEnabled') return vault.encodeFunctionResult(name, [options.enabled ?? true]);
      if (name === 'proposals') {
        const fragment = iface.getFunction(name);
        const values = fragment.outputs.map(output => {
          if (output.name === 'proposalDataHash') return hashProposalData(actionData);
          if (output.name === 'maxTotalSharesAndLootAtVote') return 1000n;
          if (output.type === 'address') return WALLET;
          if (output.type === 'string') return '';
          return 0n;
        });
        return iface.encodeFunctionResult(name, values);
      }
      const result = {
        state: [options.state ?? ProposalState.Ready],
        getProposalStatus: [[false, options.processed ?? false, false, false]],
        sharesToken: [SHARES], lootToken: [LOOT], avatar: [VAULT],
        minRetentionPercent: [options.retention ?? 0n],
        sponsorThreshold: [options.threshold ?? 10n], proposalOffering: [77n],
        getPriorVotes: [options.votes ?? 0n],
      }[name];
      if (result) return iface.encodeFunctionResult(name, result);
      if (options.simulationReverts) throw new Error('execution reverted');
      if (name === 'submitProposal') return iface.encodeFunctionResult(name, [1n]);
      return '0x';
    },
  };
  return instance;
}

test('proposal encoding matches MultiSendCallOnly byte layout and contract hash', () => {
  const decoded = new Interface(['function multiSend(bytes transactions)']).decodeFunctionData('multiSend', actionData);
  assert.equal(decoded[0], '0x00' + WALLET.slice(2) + '1'.padStart(64, '0') + '0'.repeat(64));
  assert.equal(hashProposalData(actionData), keccak256(coder.encode(['bytes'], [actionData])));
  assert.notEqual(hashProposalData(actionData), keccak256(actionData));
});

test('governance actions wrap the DAO call with executeAsGovernance', () => {
  const action = governanceAction(DAO, '0x1234');
  const wrap = new Interface(['function executeAsGovernance(address,uint256,bytes)']);
  assert.deepEqual([...wrap.decodeFunctionData('executeAsGovernance', action.data)], [DAO, 0n, '0x1234']);
});

test('encoder rejects malformed input and overflowing or negative values', () => {
  for (const value of [-1n, 1n << 256n, 1]) {
    assert.throws(() => encodeProposal([{ to: WALLET, value, data: '0x' }]), hasCode('INVALID_ARGUMENT'));
  }
  assert.throws(() => encodeProposal([]), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => encodeProposal([{ to: WALLET, value: 0n, data: '0x1' }]), hasCode('INVALID_ARGUMENT'));
  assert.throws(() => encodeProposal([{ to: '0x1', value: 0n, data: '0x' }]), hasCode('INVALID_ARGUMENT'));
});

test('all proposal reads use the same explicitly selected Cyprus-1 block', async () => {
  const mock = provider();
  const result = await new DaoShipsChain(mock, 15000).getProposal(DAO, 1);
  assert.equal(result.blockNumber, 42);
  assert.equal(result.state, ProposalState.Ready);
  assert.equal(result.processed, false);
  assert.equal(mock.calls.length, 2);
});

test('chain mismatch refuses before any contract read', async () => {
  const mock = provider({ chainId: 9n });
  await assert.rejects(new DaoShipsChain(mock, 15000).getProposal(DAO, 1), hasCode('CHAIN_MISMATCH'));
  assert.equal(mock.calls.length, 0);
});

test('chain transport errors have a stable SDK code', async () => {
  const mock = provider();
  mock.getNetwork = async () => { throw new Error('connection refused'); };
  await assert.rejects(new DaoShipsChain(mock, 15000).getProposal(DAO, 1), hasCode('CHAIN_ERROR'));
});

test('preparation rejects senders outside the supported shard or ledger', async () => {
  for (const from of ['0x0111111111111111111111111111111111111111', '0x0091111111111111111111111111111111111111']) {
    await assert.rejects(new DaoShipsChain(provider(), 15000).prepareCancel(DAO, 1, from), hasCode('INVALID_ARGUMENT'));
  }
});

test('process preparation checks the hash and simulates with the supplied sender', async () => {
  const mock = provider();
  const plan = await new DaoShipsChain(mock, 15000).prepareProcess(DAO, 1, WALLET, actionData);
  assert.equal(plan.operation, 'processProposal');
  assert.equal(plan.from, WALLET);
  assert.deepEqual([...iface.decodeFunctionData('processProposal', plan.data)], [1n, actionData]);
  assert.equal(mock.calls.at(-1).from, WALLET);
});

test('defeated closure requires no action data and preserves a separate outcome', async () => {
  const plan = await new DaoShipsChain(provider({ state: ProposalState.Defeated }), 15000).prepareProcess(DAO, 1, WALLET);
  assert.deepEqual([...iface.decodeFunctionData('processProposal', plan.data)], [1n, '0x']);
});

for (const [name, options, data, code] of [
  ['already processed defeat', { state: ProposalState.Defeated, processed: true }, undefined, 'PROPOSAL_STATE'],
  ['voting', { state: ProposalState.Voting }, actionData, 'PROPOSAL_STATE'],
  ['missing bytes', {}, undefined, 'INVALID_ARGUMENT'],
  ['wrong hash', {}, '0x1234', 'HASH_MISMATCH'],
  ['retention veto', { retention: 5000n }, actionData, 'RETENTION_VETO'],
  ['disabled vault module', { enabled: false }, actionData, 'PROPOSAL_STATE'],
  ['simulation revert', { simulationReverts: true }, actionData, 'CHAIN_ERROR'],
]) {
  test(`process preparation refuses ${name}`, async () => {
    await assert.rejects(new DaoShipsChain(provider(options), 15000).prepareProcess(DAO, 1, WALLET, data), hasCode(code));
  });
}

test('retention floor equality remains processable', async () => {
  await new DaoShipsChain(provider({ retention: 2000n }), 15000).prepareProcess(DAO, 1, WALLET, actionData);
});

test('submit offering uses historical votes and threshold capped at supply', async () => {
  for (const [options, value] of [[{}, 77n], [{ votes: 10n }, 0n], [{ threshold: 200n, votes: 100n }, 0n]]) {
    const mock = provider(options);
    const plan = await new DaoShipsChain(mock, 15000).prepareSubmit(DAO, WALLET, actionData, 'proposal');
    assert.equal(plan.value, value);
    const prior = mock.calls.map(tx => { try { return iface.parseTransaction(tx); } catch { return null; } })
      .find(tx => tx?.name === 'getPriorVotes');
    assert.equal(prior.args[1], 1699999999n);
  }
});

test('vote and sponsor preparations enforce state and simulate permissions', async () => {
  const chain = new DaoShipsChain(provider({ state: ProposalState.Voting }), 15000);
  const plan = await chain.prepareVote(DAO, 1, false, WALLET);
  assert.deepEqual([...iface.decodeFunctionData('submitVote', plan.data)], [1n, false]);
  await assert.rejects(chain.prepareSponsor(DAO, 1, WALLET), hasCode('PROPOSAL_STATE'));
  await assert.rejects(chain.prepareVote(DAO, 0, true, WALLET), hasCode('INVALID_ARGUMENT'));
  await assert.rejects(chain.prepareVote(DAO, 1, 'false', WALLET), hasCode('INVALID_ARGUMENT'));
  await new DaoShipsChain(provider({ state: ProposalState.Submitted }), 15000).prepareSponsor(DAO, 1, WALLET);
  await new DaoShipsChain(provider(), 15000).prepareCancel(DAO, 1, WALLET);
});

function processLog(passed, failed, emitter = DAO, id = 1n) {
  return { address: emitter, ...iface.encodeEventLog(iface.getEvent('ProcessProposal'), [id, passed, failed, WALLET]) };
}
test('receipts distinguish action execution, action failure, and defeat despite status 1', () => {
  for (const [passed, failed, outcome] of [[true, false, 'executed'], [true, true, 'action_failed'], [false, false, 'defeated']]) {
    const receipt = { status: 1, logs: [processLog(passed, failed)] };
    assert.equal(parseProcessReceipt(receipt, DAO, 1), outcome);
    if (outcome === 'executed') assertActionSucceeded(receipt, DAO, 1);
    else assert.throws(() => assertActionSucceeded(receipt, DAO, 1), hasCode(passed ? 'ACTION_FAILED' : 'PROPOSAL_DEFEATED'));
  }
});

test('receipt parsing refuses spoofed emitters, unrelated IDs, duplicates, and failed receipts', () => {
  for (const logs of [[processLog(true, false, WALLET)], [processLog(true, false, DAO, 2n)],
    [processLog(true, false), processLog(true, false)], []]) {
    assert.throws(() => parseProcessReceipt({ status: 1, logs }, DAO, 1), hasCode('MISSING_EVENT'));
  }
  assert.throws(() => parseProcessReceipt({ status: 0, logs: [processLog(true, false)] }, DAO, 1), hasCode('TX_REVERTED'));
});

test('submit receipt extracts proposal ID from the expected DAO only', () => {
  const event = iface.encodeEventLog(iface.getEvent('SubmitProposal'),
    [7n, hashProposalData(actionData), WALLET, 60n, actionData, 0n, true, 1000n, '', 0n]);
  assert.equal(parseSubmitReceipt({ status: 1, logs: [{ address: DAO, ...event }] }, DAO), 7);
  assert.throws(() => parseSubmitReceipt({ status: 1, logs: [{ address: WALLET, ...event }] }, DAO), hasCode('MISSING_EVENT'));
});

const daoRow = { id: DAO, name: 'DAO', avatar: VAULT, shares_address: SHARES, loot_address: LOOT,
  total_shares: '1000000000000000000001', total_loot: '0' };
function indexer(fetch, extra = {}) {
  return new DaoShipsIndexer({ url: 'https://example.test', key: 'sb_publishable_test', schema: 'testnet', fetch, ...extra });
}

test('indexer casts amounts before parsing and advances past server-imposed page caps', async () => {
  const client = indexer(async (url, init) => {
    assert.equal(init.method, 'GET');
    assert.equal(init.headers['Accept-Profile'], 'testnet');
    assert.equal(init.headers.apikey, 'sb_publishable_test');
    assert.equal(init.headers.Authorization, undefined);
    assert.match(url.searchParams.get('select'), /total_shares::text/);
    assert.equal(url.searchParams.get('order'), 'id.asc');
    return Response.json(url.searchParams.get('offset') === '0' ? [daoRow] : []);
  });
  const first = await client.listDaos({ limit: 50 });
  assert.equal(first.items[0].total_shares, '1000000000000000000001');
  assert.equal(first.nextOffset, 1);
  assert.equal((await client.listDaos({ offset: first.nextOffset })).nextOffset, null);
});

test('getDao distinguishes missing records from indexer failure', async () => {
  assert.equal(await indexer(async () => Response.json([])).getDao(DAO), null);
  await assert.rejects(indexer(async () => new Response('down', { status: 503 })).getDao(DAO), hasCode('INDEXER_ERROR'));
});

test('indexer refuses lossy amounts and malformed row shapes', async () => {
  for (const body of [[{ ...daoRow, total_shares: 1e21 }], [{}], { error: 'oops' }]) {
    await assert.rejects(indexer(async () => Response.json(body)).listDaos(), hasCode('INVALID_RESPONSE'));
  }
});

test('indexer validates pagination and encodes lowercase composite proposal IDs', async () => {
  const client = indexer(async url => {
    assert.equal(url.searchParams.get('id'), `eq.${DAO}-12`);
    return Response.json([]);
  });
  assert.equal(await client.getProposal(DAO, 12), null);
  await assert.rejects(client.listDaos({ limit: 0 }), hasCode('INVALID_ARGUMENT'));
  await assert.rejects(client.listDaos({ offset: -1 }), hasCode('INVALID_ARGUMENT'));
  await assert.rejects(client.getProposal(DAO, Number.MAX_SAFE_INTEGER), hasCode('INVALID_ARGUMENT'));
});

test('indexer state and member projections retain sync flags and exact balances', async () => {
  const state = { chain_id: 15000, last_block_number: 42, last_indexed_at: null,
    is_syncing: true, requires_full_reindex: true };
  const member = { id: `${DAO}-${WALLET}`, dao_id: DAO, member_address: WALLET,
    shares: '1', loot: '0', voting_power: '1000000000000000000001' };
  const client = indexer(async url => Response.json(url.pathname.endsWith('ds_indexer_state') ? [state] : [member]));
  assert.deepEqual(await client.getState(), state);
  assert.deepEqual((await client.listMembers(DAO)).items, [member]);
});

test('indexer reports cancellation and bounded timeouts with stable error codes', async () => {
  const fetch = async (_url, { signal }) => {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json([])), 1000);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  };
  await assert.rejects(indexer(fetch).listDaos({ signal: AbortSignal.abort() }), hasCode('ABORTED'));
  await assert.rejects(indexer(fetch, { timeoutMs: 5 }).listDaos(), hasCode('TIMEOUT'));
});

test('CLI serialization preserves bigints and structured errors', () => {
  assert.equal(stringify({ amount: 1000000000000000000001n }), '{"amount":"1000000000000000000001"}');
  assert.deepEqual(JSON.parse(stringify(new DaoShipsError('RETENTION_VETO', 'Refused', { required: 20n }))),
    { code: 'RETENTION_VETO', message: 'Refused', details: { required: '20' } });
});
