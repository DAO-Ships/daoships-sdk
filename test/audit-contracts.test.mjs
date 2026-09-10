import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, Indexed, id } from 'quais';
import { ContractClient, CONTRACT_ABIS, parseContractEvents, decodeRevert, DaoShipsError } from '../dist/index.js';
import { normalizeAbiArguments } from '../dist/abi-validation.js';

const A = '0x0011111111111111111111111111111111111111';
const code = expected => error => error instanceof DaoShipsError && error.code === expected;
const dao = new ContractClient('DAOShip', A);
const token = new ContractClient('SharesERC20', A);
test('JavaScript contract inputs refuse truthy booleans, numeric coercions, sparse arrays and accessors', () => {
  for (const vote of ['false', 'true', 1, 0, null, {}, []]) assert.throws(() => dao.encode('submitVote', [1n, vote]), code('INVALID_ARGUMENT'));
  for (const amount of [1, '1', -1n, 1n << 256n]) assert.throws(() => token.encode('transfer', [A, amount]), code('INVALID_ARGUMENT'));
  assert.throws(() => dao.encode('submitVotes', [[1n, , 3n], [true, false, true]]), code('INVALID_ARGUMENT'));
  let accessed = false;
  const args = [1n]; Object.defineProperty(args, '1', { get() { accessed = true; return true; } });
  assert.throws(() => dao.encode('submitVote', args), code('INVALID_ARGUMENT'));
  assert.equal(accessed, false);
  assert.equal(dao.interface.decodeFunctionData('submitVote', dao.encode('submitVote', [1n, false]).data)[1], false);
});

test('ABI normalization verifies nested tuples, fixed arrays, signed ranges and aggregate input budgets', () => {
  const iface = new Interface(['function example((int8,bool[2],bytes4) value,string text)']);
  const params = iface.getFunction('example').inputs;
  assert.deepEqual(normalizeAbiArguments(params, [[-128n, [false, true], '0x12345678'], 'text']), [[-128n, [false, true], '0x12345678'], 'text']);
  for (const args of [[[128n, [false, true], '0x12345678'], ''], [[0n, [true], '0x12345678'], ''],
    [[0n, [true, false], '0x12'], ''], [[0n, [true, false], '0x12345678'], 5], [{}, '']]) {
    assert.throws(() => normalizeAbiArguments(params, args), code('INVALID_ARGUMENT'));
  }
  assert.throws(() => normalizeAbiArguments(params, [[0n, [false, true], '0x12345678'], '💙'], { maxBytes: 7 }), code('INVALID_ARGUMENT'));
  assert.throws(() => normalizeAbiArguments(params, [[0n, [false, true], '0x12345678'], ''], { maxItems: 3 }), code('INVALID_ARGUMENT'));
  assert.throws(() => normalizeAbiArguments(params, [], { maxItems: 0 }), code('INVALID_ARGUMENT'));
  const bytes = new ContractClient('Poster', A);
  assert.throws(() => bytes.encode('post(string,string)', ['too long', 'tag'], { maxBytes: 3 }), code('INVALID_ARGUMENT'));
});

test('canonical ABI tables are deeply immutable and inherited/ambiguous names cannot select methods', async () => {
  assert.ok(Object.isFrozen(CONTRACT_ABIS)); assert.ok(Object.isFrozen(CONTRACT_ABIS.DAOShip));
  const vote = CONTRACT_ABIS.DAOShip.find(entry => entry.name === 'submitVote');
  assert.throws(() => { vote.inputs[1].type = 'string'; }, TypeError);
  for (const name of ['__proto__', 'constructor', 'toString', 'NotAContract']) {
    assert.throws(() => new ContractClient(name, A), code('INVALID_ARGUMENT'));
  }
  assert.throws(() => new ContractClient('Poster', A).encode('post', ['', '']), code('INVALID_ARGUMENT'));
  assert.throws(() => token.encode('notAMethod', []), code('INVALID_ARGUMENT'));
  const sdk = new ContractClient('SharesERC20', A, { call: async () => '0x' });
  await assert.rejects(sdk.read('name', [], { timeoutMs: 0 }), code('INVALID_ARGUMENT'));
});

test('contract reads bound hung and oversized transports and abort before starting the provider', async () => {
  let calls = 0;
  const sdk = new ContractClient('SharesERC20', A, { call: async () => { calls++; return new Promise(() => {}); } });
  await assert.rejects(sdk.read('name', [], { timeoutMs: 2 }), code('TIMEOUT'));
  const controller = new AbortController();
  const options = { signal: controller.signal, timeoutMs: 1000 };
  const pending = sdk.read('name', [], options);
  options.signal = new AbortController().signal;
  controller.abort();
  await assert.rejects(pending, code('ABORTED'));
  assert.equal(calls, 1);
  const oversized = new ContractClient('SharesERC20', A, { call: async () => '0x' + '00'.repeat(65) });
  await assert.rejects(oversized.read('balanceOf', [A], { maxResponseBytes: 64 }), code('INVALID_RESPONSE'));
  const malformed = new ContractClient('SharesERC20', A, { call: async () => 'oops' });
  await assert.rejects(malformed.read('name', []), code('INVALID_RESPONSE'));
});

test('dynamic indexed event fields are Indexed topic hashes, not recoverable strings', () => {
  const iface = new Interface(CONTRACT_ABIS.Poster);
  const fragment = iface.getEvent('NewPost');
  const values = fragment.inputs.map(param => param.type === 'address' ? A : param.indexed ? 'topic' : 'content');
  const log = { address: A, ...iface.encodeEventLog(fragment, values) };
  const [event] = parseContractEvents({ status: 1, logs: [log] }, 'Poster', A, 'NewPost');
  const tagIndex = fragment.inputs.findIndex(param => param.type === 'string' && param.indexed);
  assert.ok(Indexed.isIndexed(event.args[tagIndex]));
  assert.equal(event.args[tagIndex].hash, id('topic'));
});

test('event parsing treats unknown outcomes conservatively and bounds malformed log data', () => {
  const iface = new Interface(CONTRACT_ABIS.SharesERC20);
  const log = { address: A, ...iface.encodeEventLog('Transfer', [A, A, 1n]) };
  assert.equal(parseContractEvents({ status: 1, logs: [log] }, 'SharesERC20', A, 'Transfer', { maxDataBytes: 32 }).length, 1);
  assert.throws(() => parseContractEvents({ status: 1, logs: [log] }, 'SharesERC20', A, 'Transfer', { maxDataBytes: 31 }), code('INVALID_RESPONSE'));
  for (const contract of ['__proto__', 'missing']) assert.throws(() => parseContractEvents({ status: 1, logs: [] }, contract, A, 'NewPost'), code('INVALID_ARGUMENT'));
  assert.throws(() => parseContractEvents({ status: null, logs: [] }, 'Poster', A, 'NewPost'), code('TX_PENDING'));
  assert.throws(() => parseContractEvents({ status: 0, logs: [] }, 'Poster', A, 'NewPost'), code('TX_REVERTED'));
  assert.throws(() => parseContractEvents({ status: 1, logs: null }, 'Poster', A, 'NewPost'), code('INVALID_RESPONSE'));
  assert.throws(() => parseContractEvents({ status: 1, logs: [null, null] }, 'Poster', A, 'NewPost', { maxLogs: 1 }), code('INVALID_RESPONSE'));
  assert.throws(() => parseContractEvents({ status: 1, logs: [{ address: A, data: '0x' + '00'.repeat(20), topics: [] }] }, 'Poster', A, 'NewPost', { maxDataBytes: 5 }), code('INVALID_RESPONSE'));
  assert.deepEqual(parseContractEvents({ status: 1, logs: [null, {}, { address: A, topics: [null], data: '0x' }] }, 'Poster', A, 'NewPost'), []);
});

test('revert decoding never invokes accessors and correctly attributes standard errors', () => {
  let accessed = false;
  const hostile = Object.defineProperty({}, 'data', { get() { accessed = true; throw Error('getter'); } });
  assert.equal(decodeRevert(hostile), null); assert.equal(accessed, false);
  const standard = new Interface(['error Error(string)']).encodeErrorResult('Error', ['test']);
  assert.deepEqual(decodeRevert(standard).contracts, ['Solidity']);
  assert.equal(decodeRevert(standard, { maxBytes: 4 }), null);
  assert.throws(() => decodeRevert('0x1234', { maxNodes: 0 }), code('INVALID_ARGUMENT'));
  const cyclic = {}; cyclic.error = cyclic; assert.equal(decodeRevert(cyclic), null);
});
