import { AbiCoder, Interface, concat, getCreate2Address, isQuaiAddress, keccak256, solidityPacked, toBeHex } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, hex, uint, type Hex } from './values.js';
import { validateVaultOwners } from './launch.js';

function bytes32(value: string): Hex {
  const result = hex(value);
  if (result.length !== 66) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected exactly 32 bytes.');
  return result;
}
export function minimalProxyBytecode(singleton: string): Hex {
  return `0x3d602d80600a3d3981f3363d3d373d3d3d363d73${address(singleton).slice(2).toLowerCase()}5af43d82803e903d91602b57fd5bf3`;
}
export function minimalProxyInitCodeHash(singleton: string): Hex { return keccak256(minimalProxyBytecode(singleton)) as Hex; }
/** bytes32 and uint256 salts pack to identical big-endian bytes in both factories. */
export function packLaunchSalt(sender: string, salt: bigint): Hex {
  return keccak256(solidityPacked(['address', 'uint256'], [address(sender), uint(salt)])) as Hex;
}
export function predictLaunchAddress(factory: string, sender: string, salt: bigint, initCodeHash: string): Hex {
  return getCreate2Address(address(factory), packLaunchSalt(sender, salt), bytes32(initCodeHash)) as Hex;
}
export function isCyprus1Address(value: string): boolean {
  try { const a = address(value); return a.startsWith('0x00') && isQuaiAddress(a); } catch { return false; }
}
/** Proxy creation bytecode must come from the artifact matching the deployed vault factory. */
export function vaultInitCodeHash(p: {
  proxyBytecode: string; implementation: string; owners: readonly string[]; threshold: bigint;
  daoShip: string; multisendCallOnly: string;
}): Hex {
  validateVaultOwners(p.owners, p.threshold);
  const bytecode = hex(p.proxyBytecode);
  if (bytecode === '0x') throw new DaoShipsError('INVALID_ARGUMENT', 'Vault proxy creation bytecode cannot be empty.');
  const iface = new Interface(['function initialize(address[] owners,uint256 threshold,uint32 minExecutionDelay,address[] initialModules,address[] initialDelegatecallTargets)']);
  const data = iface.encodeFunctionData('initialize', [p.owners, p.threshold, 0, [address(p.daoShip)], [address(p.multisendCallOnly)]]);
  return keccak256(concat([bytecode, AbiCoder.defaultAbiCoder().encode(['address', 'bytes'], [address(p.implementation), data])])) as Hex;
}
export interface SaltMiningOptions {
  factory: string; sender: string; initCodeHash: string;
  /** Deterministic starting salt; choose a fresh range for every actual launch. */
  startSalt?: bigint; maxAttempts?: number; yieldEvery?: number; signal?: AbortSignal;
  onProgress?: (progress: { attempts: number; nextSalt: bigint }) => void;
}
export interface MinedSalt { salt: bigint; saltHex: Hex; address: Hex; attempts: number }
/** Cooperative mining works in Node and browsers and settles promptly on cancellation. */
export async function mineLaunchSalt(options: SaltMiningOptions): Promise<MinedSalt> {
  options = { ...options };
  const factory = address(options.factory), sender = address(options.sender), hash = bytes32(options.initCodeHash);
  const start = uint(options.startSalt ?? 0n), max = options.maxAttempts ?? 1_000_000, batch = options.yieldEvery ?? 128;
  if (!Number.isSafeInteger(max) || max < 1 || !Number.isSafeInteger(batch) || batch < 1) throw new DaoShipsError('INVALID_ARGUMENT', 'Mining limits must be positive safe integers.');
  const checkAbort = () => { if (options.signal?.aborted) throw new DaoShipsError('ABORTED', 'Salt mining was cancelled.'); };
  for (let i = 0; i < max; i++) {
    checkAbort(); const salt = start + BigInt(i); uint(salt);
    const predicted = predictLaunchAddress(factory, sender, salt, hash);
    if (isCyprus1Address(predicted)) return { salt, saltHex: toBeHex(salt, 32) as Hex, address: predicted, attempts: i + 1 };
    if ((i + 1) % batch === 0) { options.onProgress?.({ attempts: i + 1, nextSalt: salt + 1n }); checkAbort(); }
    // Keep cancellation responsive even if callers request infrequent progress updates.
    if ((i + 1) % Math.min(batch, 128) === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
  }
  throw new DaoShipsError('INVALID_ARGUMENT', 'No Cyprus-1 salt found within the requested range.', { attempts: max, nextSalt: (start + BigInt(max)).toString() });
}

export interface LaunchSingletons { daoShip: string; shares: string; loot: string }
/** Explicit factory sender distinguishes direct DAOShipLauncher calls from combined launches. */
export function predictDAOShipAddresses(options: {
  factory: string; sender: string; singletons: LaunchSingletons;
  sharesSalt: bigint; lootSalt: bigint; daoShipSalt: bigint;
}): { daoShip: Hex; shares: Hex; loot: Hex } {
  const predict = (singleton: string, salt: bigint) => predictLaunchAddress(options.factory, options.sender, salt, minimalProxyInitCodeHash(singleton));
  return { daoShip: predict(options.singletons.daoShip, options.daoShipSalt), shares: predict(options.singletons.shares, options.sharesSalt), loot: predict(options.singletons.loot, options.lootSalt) };
}
export interface LaunchSaltMiningOptions {
  factory: string; sender: string; singletons: LaunchSingletons;
  startSalt?: bigint; maxAttempts?: number; yieldEvery?: number; signal?: AbortSignal;
  /** Omit for an existing vault or a direct DAOShipLauncher call. */
  vault?: { factory: string; proxyBytecode: string; implementation: string; owners: readonly string[]; threshold: bigint; multisendCallOnly: string };
  onProgress?: (progress: { contract: 'shares' | 'loot' | 'daoShip' | 'vault'; attempts: number; nextSalt: bigint }) => void;
}
/** Two phases: clone salts first, then vault salt using the predicted DAO as initial module. */
export async function mineDAOShipSalts(options: LaunchSaltMiningOptions): Promise<{
  daoShip: MinedSalt; shares: MinedSalt; loot: MinedSalt; vault?: MinedSalt;
}> {
  options = { ...options, singletons: { ...options.singletons },
    ...(options.vault ? { vault: { ...options.vault, owners: [...options.vault.owners] } } : {}) };
  const mine = (contract: 'shares' | 'loot' | 'daoShip' | 'vault', factory: string, initCodeHash: string) => mineLaunchSalt({
    factory, sender: options.sender, initCodeHash,
    ...(options.startSalt === undefined ? {} : { startSalt: options.startSalt }),
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.yieldEvery === undefined ? {} : { yieldEvery: options.yieldEvery }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onProgress: progress => options.onProgress?.({ contract, ...progress }),
  });
  const shares = await mine('shares', options.factory, minimalProxyInitCodeHash(options.singletons.shares));
  const loot = await mine('loot', options.factory, minimalProxyInitCodeHash(options.singletons.loot));
  const daoShip = await mine('daoShip', options.factory, minimalProxyInitCodeHash(options.singletons.daoShip));
  if (!options.vault) return { daoShip, shares, loot };
  const v = options.vault;
  const vault = await mine('vault', v.factory, vaultInitCodeHash({ ...v, daoShip: daoShip.address }));
  return { daoShip, shares, loot, vault };
}
