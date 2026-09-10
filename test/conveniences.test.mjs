import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, TypedDataEncoder, ZeroAddress } from 'quais';
import { quoteRagequit, buildTokenApprovalPlan, readTokenApprovalPlan, probeTokenPermit, buildExternalPermitTypedData } from '../dist/conveniences.js';
import { DaoShipsChain } from '../dist/chain.js';
import { CONTRACT_ABIS } from '../dist/abis.js';
const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const C = '0x0033333333333333333333333333333333333333';
const D = '0x0044444444444444444444444444444444444444';
const E = '0x0055555555555555555555555555555555555555';
const invalid = { code: 'INVALID_ARGUMENT' };
const quoteInput = { sharesSupply: 80n, lootSupply: 20n, memberShares: 30n, memberLoot: 10n,
  sharesToBurn: 20n, lootToBurn: 5n, minRetentionBps: 2000n,
  guildTokens: [{ address: ZeroAddress, balance: 1000n }, { address: A, balance: 333n }], tokens: [A, ZeroAddress] };
test('treasury rejects oversized and duplicate guild lists before balance RPC fanout', async () => {
  const iface = new Interface(CONTRACT_ABIS.DAOShip);
  for (const guild of [Array(21).fill(A), [A, A]]) {
    let balances = 0;
    const provider = { getNetwork: async () => ({ chainId: 9n }),
      getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), woHeader: { number: 100, timestamp: 1000 } }),
      call: async request => {
        const tx = iface.parseTransaction({ data: request.data });
        if (tx.name === 'avatar') return iface.encodeFunctionResult(tx.name, [B]);
        if (tx.name === 'getGuildTokens') return iface.encodeFunctionResult(tx.name, [guild]);
        balances++; throw new Error('Unexpected balance request');
      } };
    await assert.rejects(new DaoShipsChain(provider, 9).getTreasury(D), { code: 'INVALID_RESPONSE' });
    assert.equal(balances, 0);
  }
});
test('ragequit quotes preserve exact floor arithmetic, sorted selection, forfeitures and dust', () => {
  const quote = quoteRagequit(quoteInput);
  assert.equal(quote.maxBurnable, 80n);
  assert.deepEqual(quote.withdrawals.map(row => [row.token, row.amount]), [[ZeroAddress, 250n], [A, 83n]]);
  assert.equal(quote.dust, false);
  assert.deepEqual(quoteRagequit({ ...quoteInput, tokens: [A] }).omittedTokens, [ZeroAddress]);
  assert.deepEqual(quoteRagequit({ ...quoteInput, tokens: [] }).withdrawals, []);
  assert.equal(quoteRagequit({ ...quoteInput, guildTokens: [{ address: A, balance: 1n }], tokens: [A] }).dust, true);
});
test('ragequit quotes reject invalid holdings, retention breaches, missing tokens and Solidity intermediate overflow', () => {
  for (const patch of [{ sharesToBurn: 31n }, { memberLoot: 21n }, { minRetentionBps: 10001n },
    { sharesToBurn: 0n, lootToBurn: 0n }, { tokens: [A, A] }, { tokens: [B] }, { tokens: [A, ,] },
    { guildTokens: [quoteInput.guildTokens[0], quoteInput.guildTokens[0]] }, { guildTokens: [null] }, { tokens: Array(21).fill(A) }]) {
    assert.throws(() => quoteRagequit({ ...quoteInput, ...patch }), invalid);
  }
  assert.throws(() => quoteRagequit({ ...quoteInput, minRetentionBps: 9000n }), { code: 'RETENTION_VETO' });
  assert.equal(quoteRagequit({ ...quoteInput, minRetentionBps: 7500n }).maxBurnable, 25n);
  assert.throws(() => quoteRagequit({ ...quoteInput, guildTokens: [{ address: A, balance: (1n << 256n) - 1n }], tokens: [A] }), invalid);
  assert.throws(() => quoteRagequit({ ...quoteInput, sharesSupply: (1n << 256n) - 1n, lootSupply: 0n, memberLoot: 0n, lootToBurn: 0n }), invalid);
});
test('vault-member quotes use post-burn shares and loot balances while preserving original holdings', () => {
  const input = { ...quoteInput, guildTokens: [{ address: A, balance: 30n }, { address: C, balance: 10n }, { address: ZeroAddress, balance: 1000n }],
    tokens: [C, A, ZeroAddress], burnFromTreasury: { sharesToken: A, lootToken: C } };
  const quote = quoteRagequit(input);
  assert.deepEqual(quote.withdrawals.map(row => [row.token, row.balanceBeforeBurn, row.balance, row.amount]),
    [[ZeroAddress, 1000n, 1000n, 250n], [A, 30n, 10n, 2n], [C, 10n, 5n, 1n]]);
  assert.equal(quoteRagequit({ ...input, burnFromTreasury: undefined }).withdrawals[1].amount, 7n);
  assert.equal(quoteRagequit({ ...input, guildTokens: [{ address: ZeroAddress, balance: 1000n }], tokens: [ZeroAddress] }).withdrawals[0].amount, 250n);
  assert.equal(quoteRagequit({ ...input, lootToBurn: 0n }).withdrawals[2].balance, 10n);
  const maximum = (1n << 256n) - 1n;
  const fullBurn = quoteRagequit({ sharesSupply: maximum, lootSupply: 0n, memberShares: maximum, memberLoot: 0n,
    sharesToBurn: maximum, lootToBurn: 0n, minRetentionBps: 0n, guildTokens: [{ address: A, balance: maximum }],
    tokens: [A], burnFromTreasury: { sharesToken: A, lootToken: C } });
  assert.equal(fullBurn.withdrawals[0].balance, 0n); assert.equal(fullBurn.withdrawals[0].amount, 0n);
  for (const burnFromTreasury of [null, false, {}, { sharesToken: ZeroAddress, lootToken: C }, { sharesToken: A, lootToken: ZeroAddress }, { sharesToken: A, lootToken: A }]) {
    assert.throws(() => quoteRagequit({ ...input, burnFromTreasury }), invalid);
  }
  assert.throws(() => quoteRagequit({ ...input, guildTokens: [{ address: A, balance: 31n }] }), invalid);
});
test('chain quotes automatically adjust registered shares and loot only when the vault is the withdrawing member', async () => {
  const dao = new Interface(CONTRACT_ABIS.DAOShip), token = new Interface(CONTRACT_ABIS.SharesERC20);
  const provider = { getNetwork: async () => ({ chainId: 9n }),
    getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), woHeader: { number: 100, timestamp: 1000 } }),
    call: async request => {
      assert.equal(request.blockTag, 100);
      const iface = request.to === D ? dao : token, tx = iface.parseTransaction(request);
      const value = { avatar: B, sharesToken: A, lootToken: C, getGuildTokens: [A, C], minRetentionPercent: 2000n,
        totalSupply: request.to === A ? 80n : 20n, balanceOf: request.to === A ? 30n : 10n }[tx.name];
      return iface.encodeFunctionResult(tx.name, [value]);
    } };
  const chain = new DaoShipsChain(provider, 9);
  const vault = await chain.getRagequitQuote(D, B, 20n, 5n, [A, C]);
  assert.deepEqual(vault.withdrawals.map(row => [row.balanceBeforeBurn, row.balance, row.amount]), [[30n, 10n, 2n], [10n, 5n, 1n]]);
  const member = await chain.getRagequitQuote(D, E, 20n, 5n, [A, C]);
  assert.deepEqual(member.withdrawals.map(row => [row.balanceBeforeBurn, row.balance, row.amount]), [[30n, 30n, 7n], [10n, 10n, 2n]]);
});
test('chain ragequit quotes pin all supplies, holdings, retention and treasury balances and reject observed reorg', async () => {
  const dao = new Interface(CONTRACT_ABIS.DAOShip), token = new Interface(CONTRACT_ABIS.SharesERC20);
  let calls = 0;
  const options = { tokens: [A, ZeroAddress] };
  const provider = {
    getNetwork: async () => ({ chainId: 9n }),
    getBlock: async () => ({ hash: '0x' + 'ab'.repeat(32), woHeader: { number: 100, timestamp: 1000 } }),
    getBalance: async (target, block) => { assert.equal(target, B); assert.equal(block, 100); return 1000n; },
    call: async request => {
      calls++; options.tokens.splice(0);
      assert.equal(request.blockTag, 100);
      const iface = request.to === D ? dao : token;
      const tx = iface.parseTransaction({ data: request.data });
      const value = { avatar: B, sharesToken: A, lootToken: C, minRetentionPercent: 2000n, getGuildTokens: [A, ZeroAddress],
        totalSupply: request.to === A ? 80n : 20n,
        balanceOf: tx.name === 'balanceOf' && tx.args[0] === B ? 333n : request.to === A ? 30n : 10n }[tx.name];
      return iface.encodeFunctionResult(tx.name, [value]);
    },
  };
  const result = await new DaoShipsChain(provider, 9).getRagequitQuote(D, E, 20n, 5n, options.tokens);
  assert.equal(result.withdrawals[1].amount, 83n); assert.equal(result.checkedAt.blockNumber, 100); assert.ok(calls > 5);
  let blocks = 0;
  await assert.rejects(new DaoShipsChain({ ...provider, getBlock: async () => ({ hash: '0x' + (++blocks === 1 ? 'ab' : 'cd').repeat(32), woHeader: { number: 100, timestamp: 1000 } }) }, 9).getRagequitQuote(D, E, 20n, 5n, [A]), { code: 'CHAIN_ERROR' });
  await assert.rejects(new DaoShipsChain(provider, 9).getRagequitQuote(D, E, 20n, 5n, Array(21).fill(A)), invalid);
});
test('approval planning emits minimum exact approval, optional reset, no redundant writes and explicit revoke', () => {
  const input = { token: A, owner: B, spender: C, currentAllowance: 3n, requiredAllowance: 5n };
  const iface = new Interface(CONTRACT_ABIS.SharesERC20);
  const plan = buildTokenApprovalPlan(input);
  assert.deepEqual(plan.steps.map(call => iface.decodeFunctionData('approve', call.data)[1]), [0n, 5n]);
  assert.equal(Object.isFrozen(plan.steps), true); assert.equal(Object.isFrozen(plan.steps[0]), true);
  assert.equal(buildTokenApprovalPlan({ ...input, currentAllowance: 5n }).steps.length, 0);
  assert.equal(buildTokenApprovalPlan({ ...input, requiredAllowance: 0n }).steps.length, 0);
  assert.equal(buildTokenApprovalPlan({ ...input, currentAllowance: 0n }).steps.length, 1);
  assert.equal(buildTokenApprovalPlan({ ...input, resetPolicy: 'never' }).steps.length, 1);
  assert.equal(iface.decodeFunctionData('approve', plan.revoke.data)[1], 0n);
  for (const patch of [{ owner: ZeroAddress }, { resetPolicy: 'sometimes' }, { requiredAllowance: -1n }]) assert.throws(() => buildTokenApprovalPlan({ ...input, ...patch }), invalid);
});
test('approval reads capture owner, spender and required amount while awaiting the token', async () => {
  const input = { token: A, owner: B, spender: C, requiredAllowance: 5n };
  const iface = new Interface(CONTRACT_ABIS.SharesERC20);
  const plan = await readTokenApprovalPlan({ call: async request => {
    assert.equal(request.blockTag, 20); input.spender = D; input.requiredAllowance = 999n;
    return iface.encodeFunctionResult('allowance', [2n]);
  } }, input, { blockTag: 20 });
  assert.equal(plan.spender, C); assert.equal(plan.requiredAllowance, 5n);
});

const permit = new Interface(['function nonces(address) view returns (uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function name() view returns (string)', 'function version() view returns (string)',
  'function eip712Domain() view returns (bytes1,string,string,uint256,address,bytes32,uint256[])']);
const domain = { name: 'Tribute', version: '2', chainId: 9n, verifyingContract: A };
const separator = TypedDataEncoder.hashDomain(domain);
const probeOptions = { chainId: 9n, blockTag: 50 };
function permitProvider(overrides = {}) {
  const defaults = { nonces: [7n], DOMAIN_SEPARATOR: [separator], name: ['Tribute'], version: ['2'],
    eip712Domain: ['0x0f', 'Tribute', '2', 9n, A, '0x' + '00'.repeat(32), []] };
  return { getNetwork: async () => ({ chainId: 9n }), call: async request => {
    assert.equal(request.to, A); assert.equal(request.from, B); assert.equal(request.blockTag, 50);
    const method = permit.parseTransaction(request).name;
    const value = Object.hasOwn(overrides, method) ? overrides[method] : defaults[method];
    if (value instanceof Error) throw value;
    return value === null ? '0x' : typeof value === 'string' ? value : permit.encodeFunctionResult(method, value);
  } };
}
test('external permit probing validates EIP-5267 domain and produces exact typed signature data', async () => {
  const result = await probeTokenPermit(permitProvider(), A, B, probeOptions);
  assert.equal(result.supported, true); assert.equal(result.domain.version, '2'); assert.equal(result.nonce, 7n);
  assert.equal(Object.isFrozen(result.domain), true);
  const typed = buildExternalPermitTypedData(result, { spender: C, value: 50n, deadline: 900n });
  assert.equal(TypedDataEncoder.hashDomain(typed.domain), separator);
  assert.deepEqual(typed.value, { owner: B, spender: C, value: 50n, nonce: 7n, deadline: 900n });
  assert.throws(() => buildExternalPermitTypedData({ ...result, token: C }, { spender: C, value: 50n, deadline: 900n }), invalid);
});
test('permit fallback verifies on-chain version or explicit candidate instead of assuming version one', async () => {
  const missing = Object.assign(new Error('Unknown selector'), { code: 'CALL_EXCEPTION' });
  assert.equal((await probeTokenPermit(permitProvider({ eip712Domain: missing }), A, B, probeOptions)).supported, true);
  assert.deepEqual(await probeTokenPermit(permitProvider({ eip712Domain: null, version: null }), A, B, probeOptions), { supported: false, reason: 'domain-mismatch' });
  assert.equal((await probeTokenPermit(permitProvider({ eip712Domain: null, version: null }), A, B, { ...probeOptions, versionCandidates: ['1', '2'] })).supported, true);
  assert.deepEqual(await probeTokenPermit(permitProvider({ nonces: null }), A, B, probeOptions), { supported: false, reason: 'missing-permit-reads' });
  assert.deepEqual(await probeTokenPermit(permitProvider({ eip712Domain: null, name: null }), A, B, probeOptions), { supported: false, reason: 'unsupported-domain' });
});
test('permit probing rejects unsupported domain extensions, mismatched domains and changing network', async () => {
  for (const fields of [ ['0x1f', 'Tribute', '2', 9n, A, separator, []], ['0x0f', 'Tribute', '2', 8n, A, separator, []],
    ['0x0f', 'Tribute', '2', 9n, C, separator, []], ['0x0f', 'Tribute', '2', 9n, A, separator, [1n]] ]) {
    assert.deepEqual(await probeTokenPermit(permitProvider({ eip712Domain: fields }), A, B, probeOptions), { supported: false, reason: 'unsupported-domain' });
  }
  assert.deepEqual(await probeTokenPermit(permitProvider({ DOMAIN_SEPARATOR: ['0x' + '11'.repeat(32)] }), A, B, probeOptions), { supported: false, reason: 'domain-mismatch' });
  let networks = 0;
  await assert.rejects(probeTokenPermit({ ...permitProvider(), getNetwork: async () => ({ chainId: ++networks === 1 ? 9n : 8n }) }, A, B, probeOptions), { code: 'CHAIN_MISMATCH' });
});
test('permit transport failure stays an error, with bounded waits/bytes and captured abort settings', async () => {
  await assert.rejects(probeTokenPermit({ ...permitProvider(), getNetwork: async () => { throw new Error('network unavailable'); } }, A, B, probeOptions), { code: 'CHAIN_ERROR' });
  await assert.rejects(probeTokenPermit(permitProvider({ nonces: new Error('network down') }), A, B, probeOptions), { code: 'CHAIN_ERROR' });
  for (const nonces of ['0xzz', '0x11', '0x' + '00'.repeat(100)]) await assert.rejects(probeTokenPermit(permitProvider({ nonces }), A, B, { ...probeOptions, maxResponseBytes: 64 }), { code: 'INVALID_RESPONSE' });
  await assert.rejects(probeTokenPermit({ ...permitProvider(), getNetwork: async () => new Promise(() => {}) }, A, B, { ...probeOptions, timeoutMs: 2 }), { code: 'TIMEOUT' });
  let calls = 0; const controller = new AbortController();
  const options = { ...probeOptions, signal: controller.signal };
  const pending = probeTokenPermit({ ...permitProvider(), getNetwork: async () => { calls++; return { chainId: 9n }; } }, A, B, options);
  options.signal = new AbortController().signal; controller.abort();
  await assert.rejects(pending, { code: 'ABORTED' }); assert.equal(calls, 0);
  for (const patch of [{ blockTag: 'latest' }, { chainId: 0n }, { versionCandidates: '1' }, { versionCandidates: [] }, { versionCandidates: [1] }, { timeoutMs: 0 }, { maxResponseBytes: 0 }]) {
    await assert.rejects(probeTokenPermit(permitProvider(), A, B, { ...probeOptions, ...patch }), invalid);
  }
});
