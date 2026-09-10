import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContractFactory } from 'quais';
import { SCENARIOS, validateConfig, grindCreation, openEvidence, loadWalletKeys, decodeEvidence } from '../scripts/orchard/support.mjs';
import { inspectOrchard, sourceArtifact } from '../scripts/orchard/runner.mjs';
const input = JSON.parse(await readFile(new URL('../scripts/orchard/config.example.json', import.meta.url), 'utf8'));
const valid = { ...input, contractsReviewed: true };
const A = '0x0011111111111111111111111111111111111111';

test('Orchard configuration has explicit network, review, spend bounds and public-only fields', () => {
  assert.equal(SCENARIOS.length, 12);
  const config = validateConfig(valid);
  assert.equal(config.chainId, 15000); assert.equal(config.rpcUrl, 'https://orchard.rpc.quai.network');
  assert.ok(Object.isFrozen(config.deployment));
  for (const patch of [{ chainId: 9 }, { schema: 'mainnet' }, { contractsReviewed: false }, { rpcUrl: 'http://test.invalid' },
    { rpcUrl: 'https://name:secret@test.invalid' }, { rpcUrl: 'https://test.invalid?api_key=secret' }, { maxTransactions: 0 }, { maxGasLimit: '-1' },
    { maxFeePerGas: '0' }, { maxValuePerTransaction: '1e18' }, { privateKey: 'must-not-be-here' }]) {
    assert.throws(() => validateConfig({ ...valid, ...patch }), { code: 'INVALID_ARGUMENT' });
  }
});

test('Orchard native grinding matches pinned ContractFactory and is bounded and cancellable', async () => {
  const creation = await grindCreation(A, 0, '0x6000');
  assert.equal(creation.expectedAddress, ContractFactory.getContractAddress({ from: A, nonce: 0n, data: creation.creationData }));
  assert.equal(creation.creationData, '0x6000' + creation.quaiCreation.salt.slice(2));
  await assert.rejects(grindCreation(A, 0, '0x6000', { signal: AbortSignal.abort() }), { code: 'ABORTED' });
  await assert.rejects(grindCreation(A, -1, '0x6000'), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(grindCreation(A, 0, '0x6000', { maxAttempts: 0 }), { code: 'INVALID_ARGUMENT' });
});

test('Orchard evidence is durable, bigint-safe, detached and protected by an exclusive session lock', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orchard-evidence-'));
  try {
    const first = await openEvidence(directory), unlock = await first.lock();
    await assert.rejects((await openEvidence(directory)).lock(), { code: 'INVALID_ARGUMENT' });
    const original = { amount: 1n << 200n, steps: [{ status: 'submitted' }] };
    await first.put('public-plan', original); original.steps[0].status = 'mutated';
    const reopened = await openEvidence(directory), value = await reopened.get('public-plan');
    assert.equal(value.amount, 1n << 200n); assert.equal(value.steps[0].status, 'submitted');
    value.steps[0].status = 'changed'; assert.equal((await reopened.get('public-plan')).steps[0].status, 'submitted');
    assert.equal(await reopened.get('absent'), null);
    await unlock(); await (await reopened.lock())();
    assert.throws(() => decodeEvidence('{"$bigint":"-1"}'), { code: 'INVALID_ARGUMENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Orchard wallet loading is explicit, private-file only and does not evaluate shell content', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'orchard-wallet-fixture-')), file = join(directory, 'fixture.env');
  const owner = '0x' + '01'.repeat(32), member = '0x' + '02'.repeat(32);
  try {
    await writeFile(file, `ORCHARD_OWNER_PRIVATE_KEY=${owner}\nORCHARD_MEMBER_PRIVATE_KEY=${member}\n`, { mode: 0o600 });
    assert.equal((await loadWalletKeys(file)).ORCHARD_MEMBER_PRIVATE_KEY, member);
    await chmod(file, 0o644); await assert.rejects(loadWalletKeys(file), { code: 'INVALID_ARGUMENT' });
    await chmod(file, 0o600);
    await writeFile(file, `ORCHARD_OWNER_PRIVATE_KEY=$(do-not-execute)\n`);
    await assert.rejects(loadWalletKeys(file), { code: 'INVALID_ARGUMENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Orchard readiness rejects other chains and artifact verification rejects stale source inputs', async () => {
  await assert.rejects(inspectOrchard(validateConfig(valid), { async getNetwork() { return { chainId: 9n }; } }), { code: 'CHAIN_MISMATCH' });
  const root = await mkdtemp(join(tmpdir(), 'orchard-artifacts-'));
  try {
    await mkdir(join(root, 'contracts'));
    await mkdir(join(root, 'artifacts/contracts/Fixture.sol'), { recursive: true });
    await mkdir(join(root, 'artifacts/build-info'));
    await writeFile(join(root, 'contracts/Fixture.sol'), 'contract Fixture {}');
    const artifact = { bytecode: '0x6000', abi: [], contractName: 'Fixture', sourceName: 'contracts/Fixture.sol' };
    const compiled = { metadata: JSON.stringify({ sources: { 'contracts/Fixture.sol': {} } }), abi: [], evm: { bytecode: { object: '6000' } } };
    const build = { input: { sources: { 'contracts/Fixture.sol': { content: 'contract Fixture {}' } } }, output: { contracts: { 'contracts/Fixture.sol': { Fixture: compiled } } } };
    await writeFile(join(root, 'artifacts/contracts/Fixture.sol/Fixture.json'), JSON.stringify(artifact));
    await writeFile(join(root, 'artifacts/contracts/Fixture.sol/Fixture.dbg.json'), JSON.stringify({ buildInfo: '../../build-info/fixture.json' }));
    await writeFile(join(root, 'artifacts/build-info/fixture.json'), JSON.stringify(build));
    assert.deepEqual(await sourceArtifact(root, 'Fixture'), artifact);
    await writeFile(join(root, 'contracts/Fixture.sol'), 'contract Changed {}');
    await assert.rejects(sourceArtifact(root, 'Fixture'), { code: 'INVALID_ARGUMENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('Orchard read-only readiness verifies deployment graph and hosted schema without a wallet', async () => {
  const { Interface } = await import('quais');
  const config = validateConfig(valid), blockHash = '0x' + '11'.repeat(32);
  let reads = 0;
  const provider = {
    async getNetwork() { return { chainId: 15000n }; },
    async getBlock() { return { hash: blockHash, woHeader: { number: 100 } }; },
    async getCode() { return '0x6000'; },
    async call(request) {
      reads++;
      for (const name of ['daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly', 'daoShipSingleton', 'sharesSingleton', 'lootSingleton', 'implementation']) {
        const iface = new Interface([`function ${name}() view returns (address)`]);
        if (request.data === iface.encodeFunctionData(name)) return iface.encodeFunctionResult(name, [config.deployment[name === 'implementation' ? 'vaultSingleton' : name]]);
      }
      throw Error('Unexpected read');
    },
  };
  const result = await inspectOrchard(config, provider, { fetch: async (_url, request) => {
    assert.equal(request.headers['Accept-Profile'], 'testnet');
    return Response.json([{ id: 1, chain_id: 15000, last_block_number: '100', last_block_hash: blockHash,
      last_indexed_at: new Date().toISOString(), is_syncing: false, requires_full_reindex: false, reindex_reason: null, reindex_flagged_at: null }]);
  } });
  assert.equal(reads, 7); assert.equal(result.indexer.schema, 'testnet');
  assert.equal(result.discovered.blockHash, blockHash);
});
