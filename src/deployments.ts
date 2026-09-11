import { Interface, Shard, ZeroAddress, type Provider } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, hex, type Hex } from './values.js';
import { isCyprus1Address } from './launch-create2.js';

export type DeploymentProvider = Pick<Provider, 'getNetwork' | 'getBlock' | 'call' | 'getCode'>;
export interface DeploymentContracts {
  daoShipAndVaultLauncher: Hex; daoShipLauncher: Hex; quaiVaultFactory: Hex; multisendCallOnly: Hex;
  daoShipSingleton: Hex; sharesSingleton: Hex; lootSingleton: Hex; vaultSingleton: Hex;
}
export interface DiscoveredDeployment {
  chainId: number; blockNumber: number; blockHash: string; contracts: DeploymentContracts;
}
export interface DeploymentReadOptions {
  /** Per-provider-operation deadline; provider resources remain caller-owned. */
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}
/**
 * Walk immutable launcher references at one mined block and require deployed code.
 * This verifies graph consistency, not whether an operator considers this deployment current.
 */
export async function discoverDeployment(provider: DeploymentProvider, options: {
  chainId: number; launcher: string;
} & DeploymentReadOptions): Promise<DiscoveredDeployment> {
  const { chainId, signal } = options;
  const timeoutMs = options.timeoutMs ?? 30_000, maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(chainId) || chainId < 1) throw new DaoShipsError('INVALID_ARGUMENT', 'chainId must be a positive safe integer.');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) throw new DaoShipsError('INVALID_ARGUMENT', 'Deployment read limits must be positive integers.');
  const launcher = address(options.launcher);
  if (!isCyprus1Address(launcher)) throw new DaoShipsError('INVALID_ARGUMENT', 'Launcher must be a Cyprus-1 Quai address.');
  const rpc = <T>(operation: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let settled = false;
    const finish = (ok: boolean, result: unknown) => {
      if (settled) return;
      if (ok && performance.now() >= deadline) { ok = false; result = new DaoShipsError('TIMEOUT', 'Deployment provider operation timed out.'); }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (ok) resolve(result as T); else reject(result);
    };
    const abort = () => finish(false, new DaoShipsError('ABORTED', 'Deployment discovery cancelled.'));
    const timer = setTimeout(() => finish(false, new DaoShipsError('TIMEOUT', 'Deployment provider operation timed out.')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => settled ? undefined : operation()).then(value => finish(true, value), error => finish(false, error));
  });
  const bytes = (value: unknown): Hex => {
    if (typeof value !== 'string' || value.length > maxResponseBytes * 2 + 2 || !/^0x(?:[\da-fA-F]{2})*$/.test(value)) {
      throw new DaoShipsError('INVALID_RESPONSE', 'Deployment response is malformed or exceeds its byte limit.');
    }
    return value as Hex;
  };
  const checkNetwork = async () => {
    const network = await rpc(() => provider.getNetwork());
    if (network.chainId !== BigInt(chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Deployment RPC chain does not match configured chain.', { expected: chainId, actual: String(network.chainId) });
  };
  try {
    await checkNetwork();
    const block = await rpc(() => provider.getBlock(Shard.Cyprus1, 'latest'));
    if (typeof block?.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(block.hash) || !Number.isSafeInteger(block.woHeader?.number) || block.woHeader.number < 0) throw new DaoShipsError('INVALID_RESPONSE', 'RPC did not return a mined Cyprus-1 block.');
    const blockNumber = block.woHeader.number;
    const blockHash = block.hash;
    const read = async (to: Hex, method: string): Promise<Hex> => {
      const iface = new Interface([`function ${method}() view returns (address)`]);
      // Quai rejects contract accounts as senders, including in read-only calls.
      const raw = bytes(await rpc(() => provider.call({ from: ZeroAddress, to, data: iface.encodeFunctionData(method), blockTag: blockNumber })));
      const result = address(iface.decodeFunctionResult(method, raw)[0]);
      if (!isCyprus1Address(result) || BigInt(result) === 0n) throw new DaoShipsError('INVALID_RESPONSE', `${method} returned an unusable contract address.`, { to, result });
      return result;
    };
    const [daoShipLauncher, quaiVaultFactory, multisendCallOnly] = await Promise.all([
      read(launcher, 'daoShipLauncher'), read(launcher, 'quaiVaultFactory'), read(launcher, 'multisendCallOnly'),
    ]);
    const [daoShipSingleton, sharesSingleton, lootSingleton, vaultSingleton] = await Promise.all([
      read(daoShipLauncher, 'daoShipSingleton'), read(daoShipLauncher, 'sharesSingleton'), read(daoShipLauncher, 'lootSingleton'), read(quaiVaultFactory, 'implementation'),
    ]);
    const contracts = { daoShipAndVaultLauncher: launcher, daoShipLauncher, quaiVaultFactory, multisendCallOnly, daoShipSingleton, sharesSingleton, lootSingleton, vaultSingleton };
    await Promise.all(Object.entries(contracts).map(async ([name, to]) => {
      if (bytes(await rpc(() => provider.getCode(to, blockNumber))) === '0x') throw new DaoShipsError('INVALID_RESPONSE', `${name} has no deployed bytecode.`, { name, address: to, blockNumber });
    }));
    // Protect a block-number-pinned walk against a reorg during the read batch.
    const after = await rpc(() => provider.getBlock(Shard.Cyprus1, blockNumber));
    if (after?.hash !== blockHash || after.woHeader?.number !== blockNumber) throw new DaoShipsError('CHAIN_ERROR', 'Deployment snapshot block changed during discovery.');
    await checkNetwork();
    return { chainId, blockNumber, blockHash, contracts };
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('CHAIN_ERROR', 'Unable to discover deployment from its launcher.', {}, { cause });
  }
}
export async function verifyDeployment(provider: DeploymentProvider, expected: {
  chainId: number; contracts: DeploymentContracts;
} & DeploymentReadOptions): Promise<DiscoveredDeployment> {
  // Capture all expected identities before any RPC can yield to mutable caller state.
  const contracts = Object.fromEntries(['daoShipAndVaultLauncher', 'daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly', 'daoShipSingleton', 'sharesSingleton', 'lootSingleton', 'vaultSingleton']
    .map(key => [key, address(expected.contracts[key as keyof DeploymentContracts])])) as unknown as DeploymentContracts;
  const discovered = await discoverDeployment(provider, { ...expected, launcher: contracts.daoShipAndVaultLauncher });
  const mismatches = Object.keys(discovered.contracts).filter(key => {
    const k = key as keyof DeploymentContracts;
    return contracts[k] !== discovered.contracts[k];
  });
  if (mismatches.length) throw new DaoShipsError('CHAIN_MISMATCH', 'Configured contracts do not match the launcher deployment graph.', { mismatches, expected: contracts, actual: discovered.contracts });
  return discovered;
}
/** Exact ERC-1167 runtime decoding; unknown proxy layouts return null. */
export function minimalProxyImplementation(runtimeCode: string): Hex | null {
  const data = hex(runtimeCode).toLowerCase();
  const match = /^0x363d3d373d3d3d363d73([a-f0-9]{40})5af43d82803e903d91602b57fd5bf3$/.exec(data);
  return match ? address(`0x${match[1]}`) : null;
}
