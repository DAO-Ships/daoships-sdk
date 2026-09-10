import { AbiCoder, concat, isQuaiAddress, keccak256 } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, type Hex } from './values.js';

export const ZERO_ALLOWLIST_ROOT = `0x${'00'.repeat(32)}` as Hex;
/** SDK resource limits for untrusted inputs; these are not protocol membership limits. */
export const ALLOWLIST_LIMITS = Object.freeze({ maxMembers: 10_000, maxInputCharacters: 2_000_000, maxProofNodes: 256 } as const);
/** OpenZeppelin StandardMerkleTree dump format for address-only leaves. */
export interface AllowlistTreeDump {
  format: 'standard-v1'; leafEncoding: ['address']; tree: string[];
  values: { value: [string]; treeIndex: number }[];
}
function fail(message: string): never { throw new DaoShipsError('INVALID_ARGUMENT', message); }
function node(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) fail('Expected bytes32 Merkle node.');
  return value.toLowerCase() as Hex;
}
function member(value: string): Hex {
  const result = address(value);
  if (!isQuaiAddress(result) || !result.toLowerCase().startsWith('0x00') || /^0x0{40}$/.test(result)) fail('Allowlist members must be nonzero Cyprus-1 Quai ledger addresses.');
  return result;
}
export function allowlistLeaf(account: string): Hex {
  return keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(['address'], [address(account)]))) as Hex;
}
function pair(a: string, b: string): Hex { return keccak256(concat([a, b].sort())) as Hex; }
export function parseAllowlistInput(raw: string): { addresses: Hex[]; invalid: string[] } {
  if (typeof raw !== 'string' || raw.length > ALLOWLIST_LIMITS.maxInputCharacters) fail('Allowlist input exceeds the character limit.');
  const addresses: Hex[] = [], invalid: string[] = [], seen = new Set<string>();
  for (const line of raw.split(/[\n,]/).map(v => v.trim()).filter(Boolean)) {
    try { const a = member(line); if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); addresses.push(a); } }
    catch { invalid.push(line); }
  }
  return { addresses, invalid };
}
/** Sorted, double-hashed leaves and commutative nodes match BaseNavigator and OZ standard-v1. */
export function buildAllowlistTree(accounts: readonly string[]): AllowlistTreeDump | null {
  if (!Array.isArray(accounts) || accounts.length > ALLOWLIST_LIMITS.maxMembers) fail('Allowlist exceeds the SDK member limit.');
  const normalized = [...new Set(accounts.map(a => member(a).toLowerCase()))];
  if (!normalized.length) return null;
  const sorted = normalized.map((account, i) => ({ account, i, hash: allowlistLeaf(account) })).sort((a, b) => a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0);
  const tree: string[] = Array(2 * sorted.length - 1);
  const values: AllowlistTreeDump['values'] = Array(sorted.length);
  sorted.forEach((entry, i) => { const treeIndex = tree.length - 1 - i; tree[treeIndex] = entry.hash; values[entry.i] = { value: [entry.account], treeIndex }; });
  for (let i = normalized.length - 2; i >= 0; i--) tree[i] = pair(tree[2 * i + 1]!, tree[2 * i + 2]!);
  return { format: 'standard-v1', leafEncoding: ['address'], tree, values };
}
/** Reject corrupt trees and value-index mismatches before returning membership proofs. */
export function validateAllowlistTree(value: unknown): asserts value is AllowlistTreeDump {
  if (!value || typeof value !== 'object') fail('Expected allowlist tree dump.');
  const d = value as AllowlistTreeDump;
  if (d.format !== 'standard-v1' || !Array.isArray(d.leafEncoding) || d.leafEncoding.length !== 1 || d.leafEncoding[0] !== 'address' || !Array.isArray(d.tree) || !Array.isArray(d.values) || d.values.length === 0 || d.values.length > ALLOWLIST_LIMITS.maxMembers || d.tree.length !== 2 * d.values.length - 1) fail('Invalid standard-v1 allowlist shape or member limit.');
  const tree = d.tree.map(node), indices = new Set<number>(), members = new Set<string>();
  for (let i = 0; i < d.values.length - 1; i++) if (tree[i] !== pair(tree[2 * i + 1]!, tree[2 * i + 2]!)) fail('Invalid Merkle parent hash.');
  for (const entry of d.values) {
    if (!entry || !Array.isArray(entry.value) || entry.value.length !== 1 || !Number.isSafeInteger(entry.treeIndex) || entry.treeIndex < d.values.length - 1 || entry.treeIndex >= tree.length || indices.has(entry.treeIndex)) fail('Invalid allowlist value index.');
    const account = member(entry.value[0]!).toLowerCase();
    if (members.has(account)) fail('Allowlist members must be unique.');
    if (tree[entry.treeIndex] !== allowlistLeaf(account)) fail('Allowlist leaf does not match member.');
    members.add(account);
    indices.add(entry.treeIndex);
  }
}
export function getAllowlistProof(dump: AllowlistTreeDump, account: string): Hex[] | null {
  validateAllowlistTree(dump); const wanted = member(account).toLowerCase();
  const entry = dump.values.find(v => v.value[0].toLowerCase() === wanted);
  if (!entry) return null;
  const proof: Hex[] = []; let i = entry.treeIndex;
  while (i > 0) { proof.push(node(dump.tree[i % 2 === 0 ? i - 1 : i + 1])); i = Math.floor((i - 1) / 2); }
  return proof;
}
export function verifyAllowlistProof(root: string, account: string, proof: readonly string[]): boolean {
  try {
    if (!Array.isArray(proof) || proof.length > ALLOWLIST_LIMITS.maxProofNodes) return false;
    let hash = allowlistLeaf(account);
    for (const sibling of proof) hash = pair(hash, node(sibling));
    return hash === node(root);
  }
  catch { return false; }
}
export function verifyAllowlistRoot(dump: unknown, expectedRoot: string): boolean {
  try { validateAllowlistTree(dump); return node(dump.tree[0]) === node(expectedRoot); } catch { return false; }
}
export function isAllowlisted(dump: AllowlistTreeDump, account: string): boolean { return getAllowlistProof(dump, account) !== null; }
/** Only a canonical all-zero bytes32 root denotes unrestricted access on-chain. */
export function isOpenAllowlist(root: string): boolean { return node(root) === ZERO_ALLOWLIST_ROOT; }
