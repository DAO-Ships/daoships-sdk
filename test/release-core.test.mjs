import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'quais';
import { parseContractEvents, decodeRevert, CONTRACT_ABIS } from '../dist/index.js';

const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
test('event selection avoids decoding other event payloads while retaining the aggregate byte limit', () => {
  const iface = new Interface(CONTRACT_ABIS.SharesERC20);
  const approval = { address: A, ...iface.encodeEventLog(iface.getEvent('Approval'), [A, B, 7n]) };
  const transfer = { address: A, ...iface.encodeEventLog(iface.getEvent('Transfer'), [A, B, 3n]) };
  const original = Interface.prototype.parseLog;
  let decoded = 0;
  Interface.prototype.parseLog = function (log) { decoded++; return original.call(this, log); };
  try {
    const events = parseContractEvents({ status: 1, logs: [approval, transfer] }, 'SharesERC20', A, 'Transfer');
    assert.equal(events.length, 1); assert.equal(events[0].args.value, 3n); assert.equal(decoded, 1);
    assert.throws(() => parseContractEvents({ status: 1, logs: [approval, transfer] }, 'SharesERC20', A, 'Transfer', { maxDataBytes: 32 }), { code: 'INVALID_RESPONSE' });
  } finally { Interface.prototype.parseLog = original; }
});

test('lazy event and error interfaces preserve cross-contract decoding and contract allowlists', () => {
  assert.throws(() => parseContractEvents({ status: 1, logs: [] }, 'constructor', A, 'Transfer'), { code: 'INVALID_ARGUMENT' });
  for (const name of ['DAOShip', 'BudgetNavigator', 'QuaiVault']) {
    const iface = new Interface(CONTRACT_ABIS[name]);
    const fragment = iface.fragments.find(f => f.type === 'error' && f.inputs.length === 0);
    const error = decodeRevert(iface.encodeErrorResult(fragment, []));
    assert.equal(error.signature, fragment.format('sighash')); assert.ok(error.contracts.includes(name));
  }
});
