import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Interface, keccak256, toUtf8Bytes } from 'quais';
import { CONTRACT_ABIS } from '../../dist/abis.js';
import { buildNavigatorDeploymentPlan } from '../../dist/deployment-workflows.js';

export const A = '0x0011111111111111111111111111111111111111';
export const B = '0x0022222222222222222222222222222222222222';
export const V = '0x0033333333333333333333333333333333333333';
export const N = '0x0044444444444444444444444444444444444444';
export const BLOCK = '0x' + '44'.repeat(32);
export const prepared = { chainId: 9, from: A, to: B, data: '0x1234', value: 1n << 200n, operation: 'conformance', checkedAt: { blockNumber: 10, blockHash: BLOCK } };
export async function broadcasts(directory) {
  try { return (await readFile(join(directory, 'broadcasts.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
  catch (cause) { if (cause.code === 'ENOENT') return []; throw cause; }
}
/** Durable fake-chain journal: a process exit cannot undo a recorded send. */
async function broadcast(directory, id, request) {
  const entry = { id, hash: keccak256(toUtf8Bytes(id)), ...request };
  const file = await open(join(directory, 'broadcasts.jsonl'), 'a', 0o600);
  try { await file.writeFile(JSON.stringify(entry, (_key, value) => typeof value === 'bigint' ? value.toString() : value) + '\n'); await file.sync(); }
  finally { await file.close(); }
  return entry;
}
export function recoveryFixture(directory, id, afterBroadcast = async () => {}) {
  const provider = {
    getNetwork: async () => ({ chainId: 9n }), getTransactionCount: async () => 0,
    async getTransaction(hash) { const entry = (await broadcasts(directory)).find(row => row.hash === hash); return entry ? { ...entry, chainId: BigInt(entry.chainId), value: BigInt(entry.value) } : null; },
    async getTransactionReceipt(hash) { const tx = await provider.getTransaction(hash); return tx ? { hash, from: tx.from, to: tx.to, status: 1, blockNumber: 10, blockHash: BLOCK, logs: [] } : null; },
    getBlock: async (_shard, tag) => ({ hash: BLOCK, woHeader: { number: tag === 'latest' ? 12 : tag } }),
  };
  const signer = { provider, getAddress: async () => A, estimateGas: async () => 100n,
    async sendTransaction(request) { const tx = await broadcast(directory, id, request); await afterBroadcast(); return { hash: tx.hash, wait: () => provider.getTransactionReceipt(tx.hash) }; } };
  return { provider, signer };
}
export function workflowFixture(directory, afterBroadcast = async () => {}) {
  const plan = buildNavigatorDeploymentPlan({ chainId: 9, from: A, addressPolicy: 'evm', kind: 'VestingNavigator',
    config: { daoShip: B, name: 'Conformance', description: 'Disposable executor fixture' }, bytecode: '0x6000', expectedAddress: N, vault: V });
  const dao = new Interface(CONTRACT_ABIS.DAOShip), nav = new Interface(CONTRACT_ABIS.VestingNavigator);
  const id = `${plan.id}:create`;
  const entry = async () => (await broadcasts(directory)).find(row => row.id === id);
  const provider = {
    getNetwork: async () => ({ chainId: 9n }),
    getBlock: async (_shard, tag) => ({ hash: BLOCK, woHeader: { number: tag === 'latest' ? 12 : tag } }),
    async getCode(target) { return target.toLowerCase() === N.toLowerCase() && !await entry() ? '0x' : '0x6000'; },
    async getTransaction(hash) { const row = await entry(); return row?.hash === hash ? { ...row, chainId: BigInt(row.chainId), value: BigInt(row.value) } : null; },
    async getTransactionReceipt(hash) {
      const row = await entry();
      return row?.hash === hash ? { hash, from: A, to: null, status: 1, blockNumber: 10, blockHash: BLOCK, contractAddress: N,
        logs: [{ address: N, ...nav.encodeEventLog(nav.getEvent('NavigatorDeployed'), [B, A, 'VestingNavigator', plan.metadata.name, plan.metadata.description]) }] } : null;
    },
    async call(request) {
      const iface = request.to.toLowerCase() === B.toLowerCase() ? dao : nav;
      const parsed = iface.parseTransaction(request);
      const result = { avatar: V, daoShip: B, navigatorType: 'VestingNavigator', navigators: 2n }[parsed.name];
      if (result === undefined) throw Error(`Unexpected fixture read: ${parsed.name}`);
      return iface.encodeFunctionResult(parsed.fragment, [result]);
    },
  };
  const executors = { creation: { async execute(_plan, step, context) {
    const tx = await broadcast(directory, id, { chainId: 9n, from: A, to: null, nonce: 0, data: step.creationData, value: 0n });
    await afterBroadcast(); await context.onSubmitted(tx.hash);
    return provider.getTransactionReceipt(tx.hash);
  } } };
  return { plan, provider, executors };
}
