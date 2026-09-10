import { AbiCoder, Interface, ZeroAddress } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, hex, uint, type Hex } from './values.js';
import { governanceAction, type ProposalAction } from './encoding.js';
import { normalizeAbiArguments, DEFAULT_ABI_INPUT_LIMITS } from './abi-validation.js';

export const GOVERNANCE_CONFIG_TYPES = Object.freeze(['uint32', 'uint32', 'uint256', 'uint256', 'uint256', 'uint256', 'uint32'] as const);
export const GOVERNANCE_LIMITS = Object.freeze({ minVotingPeriod: 60, maxVotingPeriod: 31_536_000, maxGracePeriod: 31_536_000, maxNavigatorsPerCall: 20, maxGuildTokens: 20, basisPoints: 10_000n } as const);
export const TOKEN_MINT_CAPS = Object.freeze({ shares: (1n << 216n) - 1n, loot: ((1n << 256n) - 1n) / 2n } as const);
export const NAVIGATOR_PERMISSIONS = Object.freeze({ NONE: 0n, ADMIN: 1n, MANAGER: 2n, GOVERNOR: 4n, ALL: 7n } as const);
export interface GovernanceConfig {
  votingPeriod: number; gracePeriod: number; proposalOffering: bigint; quorumPercent: bigint;
  sponsorThreshold: bigint; minRetentionPercent: bigint; defaultExpiryWindow: number;
}
const coder = AbiCoder.defaultAbiCoder();
export function validateGovernanceConfig(config: GovernanceConfig): void {
  for (const [name, value, min, max] of [
    ['votingPeriod', config.votingPeriod, 60, 31_536_000], ['gracePeriod', config.gracePeriod, 0, 31_536_000],
    ['defaultExpiryWindow', config.defaultExpiryWindow, 0, 0xffffffff],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new DaoShipsError('INVALID_ARGUMENT', `${name} must be an integer from ${min} to ${max}.`);
  }
  uint(config.proposalOffering); uint(config.sponsorThreshold);
  for (const value of [config.quorumPercent, config.minRetentionPercent]) {
    if (uint(value) > 10_000n) throw new DaoShipsError('INVALID_ARGUMENT', 'Governance basis points must be from 0 to 10000.');
  }
}
export function encodeGovernanceConfig(config: GovernanceConfig): Hex {
  validateGovernanceConfig(config);
  return coder.encode(GOVERNANCE_CONFIG_TYPES, [config.votingPeriod, config.gracePeriod, config.proposalOffering, config.quorumPercent, config.sponsorThreshold, config.minRetentionPercent, config.defaultExpiryWindow]) as Hex;
}
/** Strict current-version codec: rejects truncated, trailing and noncanonical data. */
export function decodeGovernanceConfig(encoded: string): GovernanceConfig {
  try {
    const data = hex(encoded);
    const d = coder.decode(GOVERNANCE_CONFIG_TYPES, data);
    const config = { votingPeriod: Number(d[0]), gracePeriod: Number(d[1]), proposalOffering: d[2] as bigint, quorumPercent: d[3] as bigint, sponsorThreshold: d[4] as bigint, minRetentionPercent: d[5] as bigint, defaultExpiryWindow: Number(d[6]) };
    if (encodeGovernanceConfig(config).toLowerCase() !== data.toLowerCase()) throw new Error('Noncanonical configuration');
    return config;
  } catch (cause) { throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid seven-field governance configuration.', {}, { cause }); }
}
export const GOVERNANCE_ABI = Object.freeze([
  'function mintShares(address[] to,uint256[] amount)', 'function mintLoot(address[] to,uint256[] amount)',
  'function burnShares(address[] from,uint256[] amount)', 'function burnLoot(address[] from,uint256[] amount)',
  'function convertSharesToLoot(address from,uint256 amount)', 'function setAdminConfig(bool pauseShares,bool pauseLoot)',
  'function setGovernanceConfig(bytes governanceConfig)', 'function setNavigators(address[] navigators,uint256[] permissions)',
  'function setGuildTokens(address[] tokens,bool[] enabled)', 'function lockAdmin()', 'function lockManager()', 'function lockGovernor()',
] as const);
const iface = new Interface(GOVERNANCE_ABI);
export type GovernanceCall =
  | { method: 'mintShares' | 'mintLoot' | 'burnShares' | 'burnLoot'; accounts: readonly string[]; amounts: readonly bigint[] }
  | { method: 'convertSharesToLoot'; account: string; amount: bigint }
  | { method: 'setAdminConfig'; pauseShares: boolean; pauseLoot: boolean }
  | { method: 'setGovernanceConfig'; config: GovernanceConfig }
  | { method: 'setNavigators'; navigators: readonly string[]; permissions: readonly bigint[] }
  | { method: 'setGuildTokens'; tokens: readonly string[]; enabled: readonly boolean[] }
  | { method: 'lockAdmin' | 'lockManager' | 'lockGovernor' };
export function validatePermission(value: bigint): bigint {
  if (uint(value) > 7n) throw new DaoShipsError('INVALID_ARGUMENT', 'Navigator permission must be from 0 to 7.');
  return value;
}
function boolean(value: boolean): boolean {
  if (typeof value !== 'boolean') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a boolean.');
  return value;
}
function sameLength(a: readonly unknown[], b: readonly unknown[]): void {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length > DEFAULT_ABI_INPUT_LIMITS.maxItems || b.length > DEFAULT_ABI_INPUT_LIMITS.maxItems) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected bounded parallel arrays.');
  if (a.length !== b.length) throw new DaoShipsError('INVALID_ARGUMENT', 'Parallel arrays must have equal lengths.');
}
/** Encodes direct DAO calldata; authorization and balances still require a chain preflight. */
export function encodeGovernanceCall(call: GovernanceCall): Hex {
  if (!call || typeof call !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected governance call object.');
  let args: readonly unknown[];
  switch (call.method) {
    case 'mintShares': case 'mintLoot': case 'burnShares': case 'burnLoot':
      sameLength(call.accounts, call.amounts);
      if (!call.accounts.length) throw new DaoShipsError('INVALID_ARGUMENT', 'Token batches cannot be empty.');
      if (call.method === 'mintShares' || call.method === 'mintLoot') {
        const total = call.amounts.reduce((sum, amount) => sum + uint(amount), 0n);
        const cap = call.method === 'mintShares' ? TOKEN_MINT_CAPS.shares : TOKEN_MINT_CAPS.loot;
        if (total > cap) throw new DaoShipsError('INVALID_ARGUMENT', 'Mint batch exceeds the token supply cap.');
      }
      args = [call.accounts.map(a => { const v = address(a); if (v === ZeroAddress) throw new DaoShipsError('INVALID_ARGUMENT', 'Token account cannot be zero.'); return v; }), call.amounts.map(a => uint(a))]; break;
    case 'convertSharesToLoot':
      if (uint(call.amount) === 0n || address(call.account) === ZeroAddress) throw new DaoShipsError('INVALID_ARGUMENT', 'Conversion requires a nonzero account and amount.');
      args = [address(call.account), call.amount]; break;
    case 'setAdminConfig': args = [boolean(call.pauseShares), boolean(call.pauseLoot)]; break;
    case 'setGovernanceConfig': args = [encodeGovernanceConfig(call.config)]; break;
    case 'setNavigators':
      sameLength(call.navigators, call.permissions);
      if (call.navigators.length > 20) throw new DaoShipsError('INVALID_ARGUMENT', 'At most 20 navigators may be updated per call.');
      args = [call.navigators.map(address), call.permissions.map(validatePermission)]; break;
    case 'setGuildTokens': sameLength(call.tokens, call.enabled); args = [call.tokens.map(address), call.enabled.map(boolean)]; break;
    case 'lockAdmin': case 'lockManager': case 'lockGovernor': args = []; break;
    default: throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown governance method.');
  }
  return iface.encodeFunctionData(call.method, normalizeAbiArguments(iface.getFunction(call.method)!.inputs, args)) as Hex;
}
/** Wraps the self-call required when the vault executes a governance proposal. */
export function buildGovernanceAction(dao: string, call: GovernanceCall): ProposalAction {
  return governanceAction(dao, encodeGovernanceCall(call));
}
/** Role locks affect future grants; existing role holders retain their permissions. */
export function governanceRequiresProposal(method: GovernanceCall['method'], permissions: bigint): boolean {
  validatePermission(permissions);
  switch (method) {
    case 'mintShares': case 'mintLoot': case 'burnShares': case 'burnLoot': case 'convertSharesToLoot': return (permissions & 2n) === 0n;
    case 'setAdminConfig': return (permissions & 1n) === 0n;
    case 'setGovernanceConfig': return (permissions & 4n) === 0n;
    case 'setNavigators': case 'setGuildTokens': case 'lockAdmin': case 'lockManager': case 'lockGovernor': return true;
    default: throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown governance method.');
  }
}
