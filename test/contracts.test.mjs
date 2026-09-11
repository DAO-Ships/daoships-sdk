import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, ZeroAddress, TypedDataEncoder, AbiCoder, keccak256, toUtf8Bytes } from 'quais';
import { ContractClient, CONTRACT_ABIS, parseContractEvents, decodeRevert,
  DaoShipsToken, parseTokenAmount, formatTokenAmount, buildPermitTypedData } from '../dist/index.js';

const A = '0x0011111111111111111111111111111111111111';
const B = '0x0022222222222222222222222222222222222222';
const shares = new Interface(CONTRACT_ABIS.SharesERC20);
test('contract reads use the zero sender by default for Orchard EOA validation', async () => {
  const client = new ContractClient('SharesERC20', A, { async call(request) {
    assert.equal(request.from, ZeroAddress);
    assert.equal(request.to, A);
    return shares.encodeFunctionResult('balanceOf', [42n]);
  } });
  assert.equal(await client.read('balanceOf', [B]), 42n);
});
test('typed contract calls encode writes and preserve read sender, block, named tuples and integers', async () => {
  const sdk = new ContractClient('SharesERC20', A, { async call(request) {
    assert.equal(request.from, B); assert.equal(request.blockTag, 42);
    return shares.encodeFunctionResult('balanceOf', [(1n << 200n) + 1n]);
  } });
  assert.equal(await sdk.read('balanceOf', [B], { from: B, blockTag: 42 }), (1n << 200n) + 1n);
  assert.equal(sdk.encode('transfer', [B, 123n]).data, shares.encodeFunctionData('transfer', [B, 123n]));
  assert.throws(() => sdk.encode('balanceOf', [B]), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => sdk.encode('transfer', [B, 123n], { value: 1n }), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(sdk.read('transfer', [B, 123n]), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(new ContractClient('SharesERC20', A).read('name', []), { code: 'CHAIN_ERROR' });
});

test('every ABI can be instantiated, including wrapped QuaiVault artifacts and Poster overloads', () => {
  for (const name of Object.keys(CONTRACT_ABIS)) assert.ok(new ContractClient(name, A).interface.fragments.length);
  const poster = new ContractClient('Poster', A);
  assert.equal(poster.encode('post(string,string)', ['hello', 'tag']).operation, 'post(string,string)');
  const factory = new ContractClient('QuaiVaultFactory', A);
  const call = factory.encode('createWallet(address[],uint256,bytes32,uint32,address[],address[])',
    [[A], 1n, '0x' + '00'.repeat(32), 0n, [B], [B]]);
  assert.equal(factory.interface.parseTransaction(call).name, 'createWallet');
  assert.ok(factory.interface.getFunction('predictWalletAddress'));
});

test('typed event decoding rejects spoofed emitters and matches event signatures', () => {
  const iface = new Interface(CONTRACT_ABIS.DAOShipAndVaultLauncher);
  const fragment = iface.getEvent('LaunchDAOShipAndVault');
  const args = fragment.inputs.map(p => p.type === 'address' ? A : 1n);
  const encoded = iface.encodeEventLog(fragment, args);
  const receipt = { status: 1, logs: [{ address: B, ...encoded }, { address: A, ...encoded }] };
  const parsed = parseContractEvents(receipt, 'DAOShipAndVaultLauncher', A, 'LaunchDAOShipAndVault');
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].name, 'LaunchDAOShipAndVault');
  assert.equal(parsed[0].args[0], A);
});

test('revert decoder covers all shipped dictionaries, standard errors, nested RPC errors and unknown data', () => {
  for (const [name, abi] of Object.entries(CONTRACT_ABIS)) {
    const iface = new Interface(abi);
    const fragment = iface.fragments.find(f => f.type === 'error' && f.inputs.length === 0);
    if (!fragment) continue;
    const parsed = decodeRevert({ info: { error: { data: iface.encodeErrorResult(fragment, []) } } });
    assert.equal(parsed.name, fragment.name, name);
    assert.ok(parsed.contracts.includes(name));
  }
  const standard = new Interface(['error Error(string)', 'error Panic(uint256)']);
  assert.equal(decodeRevert(standard.encodeErrorResult('Error', ['rejected'])).args[0], 'rejected');
  assert.equal(decodeRevert(standard.encodeErrorResult('Panic', [0x11n])).args[0], 0x11n);
  assert.equal(decodeRevert('0xdeadbeef'), null);
  const cycle = {}; cycle.cause = cycle;
  assert.equal(decodeRevert(cycle), null);
});

test('token amount conversion is exact across all uint8 decimals without rounding', () => {
  assert.equal(parseTokenAmount('1.000000000000000001', 18), 1000000000000000001n);
  assert.equal(formatTokenAmount(1000000000000000001n, 18), '1.000000000000000001');
  for (const decimals of [0, 1, 6, 18, 80, 81, 255]) {
    assert.equal(parseTokenAmount(formatTokenAmount(123n, decimals), decimals), 123n);
  }
  for (const input of ['1e3', '-1', '1.001', ' 1', '1.']) assert.throws(() => parseTokenAmount(input, 2), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => parseTokenAmount((1n << 256n).toString(), 0), { code: 'INVALID_ARGUMENT' });
  assert.throws(() => formatTokenAmount(1n, 256), { code: 'INVALID_ARGUMENT' });
});

test('token metadata, transfer, approval and delegation compose with encoded call preparation', async () => {
  const token = new DaoShipsToken(A, { async call(request) {
    const method = shares.parseTransaction(request).name;
    return shares.encodeFunctionResult(method, [{ name: 'Crew', symbol: 'CREW', decimals: 18n, totalSupply: 1n << 200n }[method]]);
  } });
  assert.deepEqual(await token.metadata(), { address: A, name: 'Crew', symbol: 'CREW', decimals: 18, totalSupply: 1n << 200n });
  for (const call of [token.transfer(B, 1n), token.approve(B, 1n), token.delegate(B)]) {
    assert.equal(call.value, 0n); assert.equal(call.to, A); assert.ok(shares.parseTransaction(call));
  }
});

test('permit domain hash matches clone-safe DAOShipPermit Solidity field order', () => {
  const typed = buildPermitTypedData({ token: A, name: 'Crew', chainId: 15000n,
    owner: A, spender: B, value: 10n, nonce: 2n, deadline: 1234n });
  const hash = s => keccak256(toUtf8Bytes(s));
  const expected = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'bytes32', 'bytes32', 'uint256', 'address'],
    [hash('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'), hash('Crew'), hash('1'), 15000n, A]));
  assert.equal(TypedDataEncoder.hashDomain(typed.domain), expected);
  assert.equal(TypedDataEncoder.hash(typed.domain, typed.types, typed.value).length, 66);
});

test('contract ABI decode failures are distinguished from provider failures', async () => {
  const invalidUtf8 = '0x' + '20'.padStart(64, '0') + '01'.padStart(64, '0') + 'ff'.padEnd(64, '0');
  for (const raw of ['0x', invalidUtf8]) {
    await assert.rejects(new ContractClient('SharesERC20', A, { async call() { return raw; } }).read('name', []), { code: 'INVALID_RESPONSE' });
  }
  await assert.rejects(new ContractClient('SharesERC20', A, { async call() { throw Error('Disconnected'); } }).read('name', []), { code: 'CHAIN_ERROR' });
});

test('provider work that blocks the event loop cannot win a deadline through a microtask', async () => {
  const provider = { call() {
    const until = performance.now() + 15;
    while (performance.now() < until) { /* Deliberately emulate a synchronous blocking transport. */ }
    return Promise.resolve(new Interface(CONTRACT_ABIS.SharesERC20).encodeFunctionResult('name', ['Late']));
  } };
  await assert.rejects(new ContractClient('SharesERC20', A, provider).read('name', [], { timeoutMs: 2 }), { code: 'TIMEOUT' });
});

test('chain, discovery and permit deadlines reject synchronous late providers', async () => {
  const { DaoShipsChain, discoverDeployment, probeTokenPermit } = await import('../dist/index.js');
  const provider = { getNetwork() {
    const until = performance.now() + 15;
    while (performance.now() < until) {}
    return Promise.resolve({ chainId: 9n });
  } };
  await assert.rejects(new DaoShipsChain(provider, 9, { timeoutMs: 2 }).getDao(A), { code: 'TIMEOUT' });
  await assert.rejects(discoverDeployment(provider, { chainId: 9, launcher: A, timeoutMs: 2 }), { code: 'TIMEOUT' });
  await assert.rejects(probeTokenPermit(provider, A, B, { chainId: 9n, blockTag: 1, timeoutMs: 2 }), { code: 'TIMEOUT' });
});
