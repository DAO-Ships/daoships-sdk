import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, concat, toBeHex } from 'quais';
import { encodeProposal, decodeProposal, hashProposalData, verifyProposalDataHash, governanceAction, ContractClient } from '../dist/index.js';
const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const multi = new Interface(['function multiSend(bytes transactions)']);
const wrap = body => multi.encodeFunctionData('multiSend', [body]);
const packed = ({ operation = 0, to = A, value = 0n, length = 0n, data = '0x' } = {}) => concat([toBeHex(operation, 1), to, toBeHex(value, 32), toBeHex(length, 32), data]);

test('proposal codec preserves raw targets, exact native values, calldata and action order', () => {
  for (let size = 1; size <= 20; size++) {
    const actions = Array.from({ length: size }, (_, index) => ({ to: index % 2 ? B : A, value: (1n << BigInt(index * 12)) + BigInt(index), data: '0x' + 'ab'.repeat(index * 3) }));
    const bytes = encodeProposal(actions);
    assert.deepEqual(decodeProposal(bytes), actions.map(action => ({ operation: 0, ...action })));
    assert.equal(encodeProposal(decodeProposal(bytes)), bytes);
  }
  assert.deepEqual(decodeProposal('0x'), []);
  assert.deepEqual(decodeProposal(wrap('0x')), []);
});

test('proposal decoder refuses unsupported operations, truncation, unsafe lengths and partial results', () => {
  const valid = packed();
  for (const body of [packed({ operation: 1 }), packed({ operation: 255 }), '0x01', valid.slice(0, -2),
    packed({ length: 1n }), packed({ length: (1n << 256n) - 1n }), concat([valid, '0xff']),
    concat([valid, packed({ length: 8n, data: '0x1234' })])]) {
    assert.throws(() => decodeProposal(wrap(body)), { code: 'INVALID_ARGUMENT' });
  }
});

test('proposal decoder validates the complete canonical outer ABI encoding', () => {
  const bytes = encodeProposal([{ to: A, value: 1n, data: '0x' }]);
  for (const malformed of ['0x1234', bytes.slice(0, -2), bytes + '00'.repeat(32), '0x00000000' + bytes.slice(10),
    bytes.slice(0, -2) + '01', undefined, { toString: () => bytes }]) {
    assert.throws(() => decodeProposal(malformed), { code: 'INVALID_ARGUMENT' });
  }
});

test('proposal codecs enforce exact byte/action budgets on both encode and decode', () => {
  const action = { to: A, value: 0n, data: '0x1234' };
  const bytes = encodeProposal([action]);
  const length = (bytes.length - 2) / 2;
  assert.equal(encodeProposal([action], { maxActions: 1, maxBytes: length }), bytes);
  assert.equal(decodeProposal(bytes, { maxActions: 1, maxBytes: length }).length, 1);
  assert.throws(() => encodeProposal([action], { maxBytes: length - 1 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => decodeProposal(bytes, { maxBytes: length - 1 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => encodeProposal([action, action], { maxActions: 1 }), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => decodeProposal(encodeProposal([action, action]), { maxActions: 1 }), { code: 'INVALID_ARGUMENT' });
  for (const options of [null, { maxBytes: 0 }, { maxActions: 0 }, { maxActions: Infinity }, { maxBytes: 1.5 }]) {
    assert.throws(() => encodeProposal([action], options), { code: 'INVALID_ARGUMENT' });
    assert.throws(() => decodeProposal(bytes, options), { code: 'INVALID_ARGUMENT' });
  }
});

test('proposal encoder rejects sparse, inherited, accessor and malformed data with structured errors', () => {
  const action = { to: A, value: 0n, data: '0x' };
  let accessed = false;
  const actionGetter = { ...action }; Object.defineProperty(actionGetter, 'data', { get() { accessed = true; return '0x'; } });
  const listGetter = [action]; Object.defineProperty(listGetter, '0', { get() { accessed = true; return action; } });
  for (const input of [[], null, {}, [, action], [Object.create(action)], [actionGetter], listGetter,
    [{ ...action, value: 1 }], [{ ...action, value: -1n }], [{ ...action, value: 1n << 256n }],
    [{ ...action, data: '0x1' }], [{ ...action, to: {} }], [{ ...action, to: 'invalid' }], [null]]) {
    assert.throws(() => encodeProposal(input), { code: 'INVALID_ARGUMENT' });
  }
  assert.equal(accessed, false);
});

test('proposal hash verifier distinguishes a mismatch from absent/malformed commitments', () => {
  const bytes = encodeProposal([{ to: A, value: 5n, data: '0x' }]);
  const commitment = hashProposalData(bytes);
  assert.equal(verifyProposalDataHash(bytes, commitment), true);
  assert.equal(verifyProposalDataHash(bytes, '0x' + commitment.slice(2).toUpperCase()), true);
  assert.equal(verifyProposalDataHash(bytes, hashProposalData('0x')), false);
  assert.equal(verifyProposalDataHash('0x', hashProposalData('0x')), true);
  for (const hash of [undefined, null, '0x1234', '0x' + 'zz'.repeat(32)]) assert.throws(() => verifyProposalDataHash(bytes, hash), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => verifyProposalDataHash(bytes, commitment, { maxBytes: 1 }), { code: 'INVALID_ARGUMENT' });
});

test('decoded governance-looking calls preserve every value and target without trusted labels', () => {
  const dao = new ContractClient('DAOShip', A);
  const inner = dao.encode('mintShares', [[B], [10n]]);
  const wrapped = governanceAction(A, inner.data);
  const spoof = { ...wrapped, to: B, value: 100n };
  const [decoded] = decodeProposal(encodeProposal([spoof]));
  assert.equal(decoded.to, B); assert.equal(decoded.value, 100n); assert.equal(decoded.data, spoof.data);
  assert.equal(Object.hasOwn(decoded, 'governanceVerified'), false);
  assert.equal(Object.hasOwn(decoded, 'label'), false);
  const parsed = dao.interface.parseTransaction({ data: decoded.data });
  assert.equal(parsed.name, 'executeAsGovernance'); assert.equal(parsed.args[0], A);
});
