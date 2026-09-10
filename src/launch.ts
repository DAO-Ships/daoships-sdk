import { AbiCoder, Interface, ZeroAddress } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, hex, uint, type Hex } from './values.js';
import { decodeGovernanceConfig, encodeGovernanceConfig, validatePermission, TOKEN_MINT_CAPS, type GovernanceConfig } from './governance.js';
import { DEFAULT_ABI_INPUT_LIMITS } from './abi-validation.js';

export const INIT_PARAMS_TYPES = Object.freeze(['address', 'address', 'address', 'address', 'bytes', 'address[]', 'uint256[]', 'address[]', 'uint256[]', 'uint256[]', 'address[]', 'bool', 'bool'] as const);
export interface LaunchInitParams {
  multisendLibrary: string; governanceConfig: GovernanceConfig;
  navigators: readonly string[]; navigatorPermissions: readonly bigint[];
  initMembers: readonly string[]; initShareAmounts: readonly bigint[]; initLootAmounts: readonly bigint[];
  guildTokens: readonly string[]; pauseSharesOnLaunch: boolean; pauseLootOnLaunch: boolean;
}
const coder = AbiCoder.defaultAbiCoder();
function nonzero(value: string): Hex {
  const result = address(value);
  if (result === ZeroAddress) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a nonzero address.');
  return result;
}
export function validateLaunchInitParams(p: LaunchInitParams): void {
  if (!p || typeof p !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected launch initialization object.');
  for (const values of [p.navigators, p.navigatorPermissions, p.initMembers, p.initShareAmounts, p.initLootAmounts, p.guildTokens]) {
    if (!Array.isArray(values) || values.length > DEFAULT_ABI_INPUT_LIMITS.maxItems) throw new DaoShipsError('INVALID_ARGUMENT', 'Launch arrays exceed the SDK item limit.');
    for (let i = 0; i < values.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new DaoShipsError('INVALID_ARGUMENT', 'Launch arrays must contain dense data entries.');
    }
  }
  encodeGovernanceConfig(p.governanceConfig); nonzero(p.multisendLibrary);
  if (p.navigators.length !== p.navigatorPermissions.length || p.initMembers.length !== p.initShareAmounts.length || p.initMembers.length !== p.initLootAmounts.length) throw new DaoShipsError('INVALID_ARGUMENT', 'Launch parallel arrays must have equal lengths.');
  if (p.navigators.length > 20) throw new DaoShipsError('INVALID_ARGUMENT', 'At most 20 initial navigators are supported.');
  p.navigators.forEach(address); p.navigatorPermissions.forEach((permission, i) => {
    uint(permission);
    if (address(p.navigators[i]!) !== ZeroAddress) validatePermission(permission);
  });
  p.initMembers.forEach(address); p.initShareAmounts.forEach(a => uint(a)); p.initLootAmounts.forEach(a => uint(a));
  // setUp deduplicates guild tokens and accepts arbitrary order. Zero means native QUAI.
  if (new Set(p.guildTokens.map(a => address(a).toLowerCase())).size > 20) throw new DaoShipsError('INVALID_ARGUMENT', 'At most 20 distinct guild tokens are supported.');
  if (typeof p.pauseSharesOnLaunch !== 'boolean' || typeof p.pauseLootOnLaunch !== 'boolean') throw new DaoShipsError('INVALID_ARGUMENT', 'Launch pause flags must be booleans.');
  // setUp skips zero-address members and navigators; preserve that contract behavior.
  let shares = 0n, loot = 0n;
  p.initMembers.forEach((a, i) => { if (address(a) !== ZeroAddress) { shares += p.initShareAmounts[i]!; loot += p.initLootAmounts[i]!; } });
  if (shares > TOKEN_MINT_CAPS.shares || loot > TOKEN_MINT_CAPS.loot) throw new DaoShipsError('INVALID_ARGUMENT', 'Initial token supply exceeds its mint cap.');
}
/** The combined launcher replaces avatar; the direct launcher requires an existing vault. */
export function encodeLaunchInitParams(p: LaunchInitParams, avatar: string = ZeroAddress): Hex {
  validateLaunchInitParams(p);
  return coder.encode(INIT_PARAMS_TYPES, [ZeroAddress, ZeroAddress, address(avatar), address(p.multisendLibrary), encodeGovernanceConfig(p.governanceConfig), p.navigators, p.navigatorPermissions, p.initMembers, p.initShareAmounts, p.initLootAmounts, p.guildTokens, p.pauseSharesOnLaunch, p.pauseLootOnLaunch]) as Hex;
}
export function decodeLaunchInitParams(encoded: string): LaunchInitParams & { lootToken: Hex; sharesToken: Hex; avatar: Hex } {
  try {
    const data = hex(encoded), d = coder.decode(INIT_PARAMS_TYPES, data);
    // Re-encoding all decoded fields rejects trailing data and noncanonical offsets.
    if (coder.encode(INIT_PARAMS_TYPES, [...d]).toLowerCase() !== data.toLowerCase()) throw new Error('Noncanonical initialization');
    const p = { lootToken: address(d[0]), sharesToken: address(d[1]), avatar: address(d[2]), multisendLibrary: address(d[3]), governanceConfig: decodeGovernanceConfig(d[4]), navigators: [...d[5]] as string[], navigatorPermissions: [...d[6]] as bigint[], initMembers: [...d[7]] as string[], initShareAmounts: [...d[8]] as bigint[], initLootAmounts: [...d[9]] as bigint[], guildTokens: [...d[10]] as string[], pauseSharesOnLaunch: d[11] as boolean, pauseLootOnLaunch: d[12] as boolean };
    validateLaunchInitParams(p); return p;
  } catch (cause) { throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid thirteen-field launch initialization.', {}, { cause }); }
}
export const LAUNCHER_ABI = Object.freeze([
  'function launchDAOShip(bytes initializationParams,string shareTokenName,string shareTokenSymbol,string lootTokenName,string lootTokenSymbol,uint256 sharesSalt,uint256 lootSalt,uint256 daoShipSalt) returns (address daoShip,address shares,address loot)',
  'function launchDAOShipAndVault(bytes initializationParamsTemplate,string shareTokenName,string shareTokenSymbol,string lootTokenName,string lootTokenSymbol,address[] vaultOwners,uint256 vaultThreshold,uint256 vaultSalt,uint256 sharesSalt,uint256 lootSalt,uint256 daoShipSalt) returns (address daoShip,address vault)',
  'function launchDAOShipWithVault(bytes initializationParamsTemplate,string shareTokenName,string shareTokenSymbol,string lootTokenName,string lootTokenSymbol,address existingVault,uint256 sharesSalt,uint256 lootSalt,uint256 daoShipSalt) returns (address daoShip)',
] as const);
const launcher = new Interface(LAUNCHER_ABI);
export interface LaunchTokenMetadata { shareTokenName: string; shareTokenSymbol: string; lootTokenName: string; lootTokenSymbol: string }
export interface LaunchSalts { sharesSalt: bigint; lootSalt: bigint; daoShipSalt: bigint }
export interface LaunchParams extends LaunchTokenMetadata, LaunchSalts { initialization: LaunchInitParams }
export function validateVaultOwners(owners: readonly string[], threshold: bigint): void {
  if (!Array.isArray(owners) || owners.length > DEFAULT_ABI_INPUT_LIMITS.maxItems) throw new DaoShipsError('INVALID_ARGUMENT', 'Vault owners exceed the SDK item limit.');
  for (let i = 0; i < owners.length; i++) {
    const descriptor = Object.getOwnPropertyDescriptor(owners, String(i));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new DaoShipsError('INVALID_ARGUMENT', 'Vault owners must contain dense data entries.');
  }
  const normalized = owners.map(nonzero);
  if (!owners.length || uint(threshold) === 0n || threshold > BigInt(owners.length)) throw new DaoShipsError('INVALID_ARGUMENT', 'Vault threshold must be between 1 and the owner count.');
  if (new Set(normalized).size !== owners.length) throw new DaoShipsError('INVALID_ARGUMENT', 'Vault owners must be unique.');
}
function launchArgs(p: LaunchParams, avatar?: string): unknown[] {
  for (const name of [p.shareTokenName, p.shareTokenSymbol, p.lootTokenName, p.lootTokenSymbol]) if (typeof name !== 'string') throw new DaoShipsError('INVALID_ARGUMENT', 'Token metadata must be strings.');
  return [encodeLaunchInitParams(p.initialization, avatar), p.shareTokenName, p.shareTokenSymbol, p.lootTokenName, p.lootTokenSymbol];
}
function salts(p: LaunchSalts): bigint[] { return [uint(p.sharesSalt), uint(p.lootSalt), uint(p.daoShipSalt)]; }
/** Call DAOShipLauncher directly. CREATE2 salt sender is the caller. */
export function encodeLaunchDAOShip(p: LaunchParams & { existingVault: string }): Hex {
  return launcher.encodeFunctionData('launchDAOShip', [...launchArgs(p, nonzero(p.existingVault)), ...salts(p)]) as Hex;
}
/** Call DAOShipAndVaultLauncher. CREATE2 salt sender is the combined launcher. */
export function encodeLaunchDAOShipWithVault(p: LaunchParams & { existingVault: string }): Hex {
  return launcher.encodeFunctionData('launchDAOShipWithVault', [...launchArgs(p), nonzero(p.existingVault), ...salts(p)]) as Hex;
}
/** New vault is initialized with delay 0, DAO module enabled and MultiSend allowlisted. */
export function encodeLaunchDAOShipAndVault(p: LaunchParams & { vaultOwners: readonly string[]; vaultThreshold: bigint; vaultSalt: bigint }): Hex {
  validateVaultOwners(p.vaultOwners, p.vaultThreshold);
  return launcher.encodeFunctionData('launchDAOShipAndVault', [...launchArgs(p), p.vaultOwners, p.vaultThreshold, uint(p.vaultSalt), ...salts(p)]) as Hex;
}
