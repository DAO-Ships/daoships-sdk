const assert = require('node:assert/strict');

// This inventory records successful SDK calls, not strings found in test source.
// Behavioral assertions live with each scenario; the inventory is a completeness gate.
class FunctionCoverage {
  constructor(sdk, kinds) {
    this.sdk = sdk;
    this.clients = new Map(kinds.map(kind => [kind, new sdk.ContractClient(kind, '0x0011111111111111111111111111111111111111')]));
    this.seen = new Map(kinds.map(kind => [kind, new Set()]));
  }

  write(kind, call, receipt) {
    assert.equal(receipt.status, 1, 'Reverted calls cannot count as executed coverage');
    const parsed = this.clients.get(kind).interface.parseTransaction(call);
    assert.ok(parsed, `Unknown ${kind} calldata`);
    this.seen.get(kind).add(parsed.signature);
    if (kind !== 'DAOShip' || parsed.name !== 'processProposal'
      || this.sdk.parseProcessReceipt(receipt, call.to, Number(parsed.args[0])) !== 'executed') return;
    // Successful outer receipts alone do not prove that proposal actions ran.
    // Count nested DAO calls only after ProcessProposal confirms action success.
    for (const action of this.sdk.decodeProposal(parsed.args[1])) {
      if (action.to.toLowerCase() !== call.to.toLowerCase()) continue;
      const nested = this.clients.get(kind).interface.parseTransaction(action);
      assert.ok(nested);
      this.seen.get(kind).add(nested.signature);
      if (nested.name === 'executeAsGovernance') {
        assert.equal(nested.args[0].toLowerCase(), call.to.toLowerCase());
        const inner = this.clients.get(kind).interface.parseTransaction({ data: nested.args[2] });
        assert.ok(inner);
        this.seen.get(kind).add(inner.signature);
      }
    }
  }

  async reads(kind, client, reference, provider, argumentsBySignature) {
    const plain = value => Array.isArray(value) ? Array.from(value, plain) : value;
    const blockTag = await provider.getBlockNumber();
    for (const fragment of this.clients.get(kind).interface.fragments) {
      if (fragment.type !== 'function' || !['view', 'pure'].includes(fragment.stateMutability)) continue;
      const signature = fragment.format();
      const args = fragment.inputs.length ? argumentsBySignature[signature] : [];
      assert.ok(args, `Add a read fixture for ${kind}.${signature}`);
      const expected = await reference.getFunction(signature).staticCall(...args, { blockTag });
      const actual = await client.read(signature, args, { blockTag });
      assert.deepEqual(plain(actual), plain(expected), `${kind}.${signature} SDK decode differs from ethers`);
      this.seen.get(kind).add(signature);
    }
  }

  assertComplete() {
    for (const [kind, client] of this.clients) {
      const functions = client.interface.fragments.filter(f => f.type === 'function');
      const missing = functions.map(f => f.format()).filter(signature => !this.seen.get(kind).has(signature));
      assert.deepEqual(missing, [], `${kind}: missing successful SDK execution/read coverage`);
      const reads = functions.filter(f => ['view', 'pure'].includes(f.stateMutability)).length;
      console.log(`${kind}: ${reads}/${reads} reads, ${functions.length - reads}/${functions.length - reads} writes executed through SDK`);
    }
  }
}
module.exports = { FunctionCoverage };
