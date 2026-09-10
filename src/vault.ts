import type { BlockTag } from 'quais';
import { ContractClient, type ContractReadOptions, type ContractReadProvider } from './contracts.js';
import { DaoShipsError } from './errors.js';
import { address, type Hex } from './values.js';

export const VAULT_MODULE_SENTINEL = '0x0000000000000000000000000000000000000001' as Hex;
export interface VaultModuleLookupOptions extends Omit<ContractReadOptions, 'blockTag'> {
  /** Required fixed block number or hex block number/hash; moving tags are rejected. */
  blockTag: BlockTag;
  pageSize?: number;
  maxPages?: number;
  maxModules?: number;
}

/**
 * Resolve disableModule's predecessor from the vault's documented pagination contract.
 * Returns null only after reaching the sentinel; incomplete or corrupt traversal throws.
 * The provider and selected vault remain caller-trusted. Refresh this lookup before
 * preparing disableModule: any intervening module insertion/removal can change the pointer.
 */
export async function resolveVaultModulePredecessor(
  provider: ContractReadProvider, vault: string, module: string, options: VaultModuleLookupOptions,
): Promise<Hex | null> {
  const target = address(module).toLowerCase();
  if (BigInt(target) <= 1n || BigInt(address(vault)) <= 1n) throw new DaoShipsError('INVALID_ARGUMENT', 'Vault and module must be nonzero, nonsentinel addresses.');
  const blockTag = options?.blockTag;
  if (!(typeof blockTag === 'number' && Number.isSafeInteger(blockTag) && blockTag >= 0)
    && !(typeof blockTag === 'string' && /^0x[0-9a-fA-F]{1,64}$/.test(blockTag))) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Module lookup requires a fixed block number or hex block identifier.');
  }
  const pageSize = options.pageSize ?? 100, maxPages = options.maxPages ?? 100, maxModules = options.maxModules ?? 10_000;
  if (![pageSize, maxPages, maxModules].every(n => Number.isSafeInteger(n) && n >= 1) || pageSize > 1000) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Lookup limits must be positive safe integers; pageSize must not exceed 1000.');
  }
  // Capture the caller's primitive read settings once, including the exact block identifier.
  // The caller may mutate its options object while a provider request is pending.
  const readOptions: ContractReadOptions = { ...options, blockTag };
  const client = new ContractClient('QuaiVault', vault, provider);
  const seen = new Set<string>(), cursors = new Set<string>();
  let cursor: Hex = VAULT_MODULE_SENTINEL, previous: Hex = VAULT_MODULE_SENTINEL, expectedFirst: Hex | undefined;
  const invalid = (message: string): never => { throw new DaoShipsError('INVALID_RESPONSE', message); };
  for (let page = 0; page < maxPages; page++) {
    const cursorKey = cursor.toLowerCase();
    if (cursors.has(cursorKey)) invalid('Vault module pagination contains a cursor cycle.');
    cursors.add(cursorKey);
    const size = Math.min(pageSize, maxModules - seen.size);
    if (size === 0) throw new DaoShipsError('INVALID_RESPONSE', 'Vault module lookup exceeded maxModules without reaching the list end.');
    const [modules, nextValue] = await client.read('getModulesPaginated', [cursor, BigInt(size)], readOptions);
    if (!Array.isArray(modules) || modules.length > size) invalid('Vault returned more modules than the requested page size.');
    const next = address(nextValue);
    if (BigInt(next) === 0n || (next !== VAULT_MODULE_SENTINEL && (!modules.length || cursors.has(next.toLowerCase())))) invalid('Vault returned an invalid or nonprogressing pagination cursor.');
    const normalized: Hex[] = [];
    for (const item of modules) {
      const current = address(item), key = current.toLowerCase();
      if (BigInt(current) <= 1n || seen.has(key)) invalid('Vault module list contains zero, sentinel or duplicate entries.');
      seen.add(key); normalized.push(current);
    }
    if (expectedFirst !== undefined && normalized[0] !== expectedFirst) invalid('Vault page does not begin with the previously announced next module.');
    if (next !== VAULT_MODULE_SENTINEL && (seen.has(next.toLowerCase()) || modules.length !== size)) invalid('Vault returned an inconsistent next module.');
    // Validate the entire returned page before trusting a target that appears in it.
    for (const current of normalized) {
      if (current.toLowerCase() === target) return previous;
      previous = current;
    }
    if (next === VAULT_MODULE_SENTINEL) return null;
    // QuaiVault returns the first *unreturned* module as next, while start is
    // exclusive. Continue from the last returned module or the boundary is skipped.
    expectedFirst = next;
    cursor = previous;
  }
  throw new DaoShipsError('INVALID_RESPONSE', 'Vault module lookup exceeded maxPages without reaching the list end.');
}
