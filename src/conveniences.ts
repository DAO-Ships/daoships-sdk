import { Interface, TypedDataEncoder, checkResultErrors, type Provider, type TypedDataDomain, type TypedDataField } from 'quais';
import { DaoShipsError } from './errors.js';
import { DaoShipsToken } from './tokens.js';
import { address, uint, type Hex } from './values.js';
import type { EncodedCall, ContractReadOptions } from './contracts.js';

export interface RagequitQuoteInput {
  sharesSupply: bigint; lootSupply: bigint; memberShares: bigint; memberLoot: bigint;
  sharesToBurn: bigint; lootToBurn: bigint; minRetentionBps: bigint;
  guildTokens: readonly { address: string; balance: bigint }[];
  /** Explicit selection. Omitted guild tokens are forfeited for the burned units. */
  tokens: readonly string[];
  /** Set only when the withdrawing member is the treasury vault itself. */
  burnFromTreasury?: { sharesToken: string; lootToken: string };
}
export interface RagequitQuote {
  totalSupply: bigint; totalBurn: bigint; minimumRemainingSupply: bigint; maxBurnable: bigint;
  withdrawals: { token: Hex; balanceBeforeBurn: bigint; balance: bigint; amount: bigint }[];
  omittedTokens: Hex[]; dust: boolean;
}
/** Exact Solidity arithmetic, including checked uint256 intermediate multiplication. */
export function quoteRagequit(input: RagequitQuoteInput): RagequitQuote {
  const { sharesSupply, lootSupply, memberShares, memberLoot, sharesToBurn, lootToBurn, minRetentionBps } = input;
  [sharesSupply, lootSupply, memberShares, memberLoot, sharesToBurn, lootToBurn, minRetentionBps].forEach(value => uint(value));
  const totalSupply = uint(sharesSupply + lootSupply), totalBurn = uint(sharesToBurn + lootToBurn);
  if (minRetentionBps > 10_000n || memberShares > sharesSupply || memberLoot > lootSupply
    || sharesToBurn > memberShares || lootToBurn > memberLoot || totalBurn === 0n || totalBurn > totalSupply) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid ragequit supply, member balance, burn or retention inputs.');
  }
  const minimumRemainingSupply = uint(totalSupply * minRetentionBps) / 10_000n;
  const maxBurnable = totalSupply - minimumRemainingSupply;
  if (totalBurn > maxBurnable) throw new DaoShipsError('RETENTION_VETO', 'Ragequit would violate the current supply retention floor.', { totalBurn, maxBurnable });
  if (!Array.isArray(input.guildTokens) || !Array.isArray(input.tokens) || input.guildTokens.length > 20 || input.tokens.length > 20) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Ragequit requires at most 20 guild tokens and selected tokens.');
  }
  const guild = new Map<Hex, bigint>();
  for (const row of input.guildTokens) {
    if (!row || typeof row !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Malformed guild token balance.');
    const token = address(row.address), balance = uint(row.balance);
    if (guild.has(token)) throw new DaoShipsError('INVALID_ARGUMENT', 'Guild token balances must be unique.');
    guild.set(token, balance);
  }
  const balancesAfterBurn = new Map(guild);
  if (input.burnFromTreasury !== undefined) {
    if (!input.burnFromTreasury || typeof input.burnFromTreasury !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Treasury burns require the shares and loot token addresses.');
    const sharesToken = address(input.burnFromTreasury.sharesToken), lootToken = address(input.burnFromTreasury.lootToken);
    if (BigInt(sharesToken) === 0n || BigInt(lootToken) === 0n || sharesToken === lootToken) throw new DaoShipsError('INVALID_ARGUMENT', 'Treasury burn tokens must be distinct nonzero addresses.');
    for (const [token, held, burned] of [[sharesToken, memberShares, sharesToBurn], [lootToken, memberLoot, lootToBurn]] as const) {
      const balance = guild.get(token);
      if (balance !== undefined) {
        if (balance !== held) throw new DaoShipsError('INVALID_ARGUMENT', 'Treasury token balance must match the withdrawing member balance.');
        balancesAfterBurn.set(token, uint(balance - burned));
      }
    }
  }
  const selected = Array.from(input.tokens, value => address(value)).sort((a, b) => BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);
  if (new Set(selected).size !== selected.length || selected.some(token => !guild.has(token))) throw new DaoShipsError('INVALID_ARGUMENT', 'Selected tokens must be unique registered guild tokens.');
  const withdrawals = selected.map(token => ({ token, balanceBeforeBurn: guild.get(token)!, balance: balancesAfterBurn.get(token)!, amount: uint(balancesAfterBurn.get(token)! * totalBurn) / totalSupply }));
  return { totalSupply, totalBurn, minimumRemainingSupply, maxBurnable, withdrawals,
    omittedTokens: [...guild.keys()].filter(token => !selected.includes(token)), dust: withdrawals.length > 0 && withdrawals.every(row => row.amount === 0n) };
}

export interface TokenApprovalPlan {
  token: Hex; owner: Hex; spender: Hex; currentAllowance: bigint; requiredAllowance: bigint;
  steps: readonly EncodedCall[]; revoke: EncodedCall;
}
/** Minimal approval increase, with a zero-reset by default when replacing a nonzero allowance. */
export function buildTokenApprovalPlan(input: {
  token: string; owner: string; spender: string; currentAllowance: bigint; requiredAllowance: bigint;
  resetPolicy?: 'when-nonzero' | 'never';
}): TokenApprovalPlan {
  const token = address(input.token), owner = address(input.owner), spender = address(input.spender);
  const currentAllowance = uint(input.currentAllowance), requiredAllowance = uint(input.requiredAllowance);
  const resetPolicy = input.resetPolicy ?? 'when-nonzero';
  if (![token, owner, spender].every(value => BigInt(value) !== 0n) || !['when-nonzero', 'never'].includes(resetPolicy)) throw new DaoShipsError('INVALID_ARGUMENT', 'Approval requires nonzero addresses and a recognized reset policy.');
  const client = new DaoShipsToken(token), revoke = Object.freeze(client.approve(spender, 0n));
  const steps: EncodedCall[] = [];
  if (currentAllowance < requiredAllowance) {
    if (currentAllowance > 0n && resetPolicy === 'when-nonzero') steps.push(revoke);
    steps.push(Object.freeze(client.approve(spender, requiredAllowance)));
  }
  return Object.freeze({ token, owner, spender, currentAllowance, requiredAllowance, steps: Object.freeze(steps), revoke });
}
export async function readTokenApprovalPlan(provider: Pick<Provider, 'call'>, input: {
  token: string; owner: string; spender: string; requiredAllowance: bigint; resetPolicy?: 'when-nonzero' | 'never';
}, options: ContractReadOptions = {}): Promise<TokenApprovalPlan> {
  const captured = { token: address(input.token), owner: address(input.owner), spender: address(input.spender), requiredAllowance: uint(input.requiredAllowance),
    ...(input.resetPolicy === undefined ? {} : { resetPolicy: input.resetPolicy }) };
  const allowance = await new DaoShipsToken(captured.token, provider).allowance(captured.owner, captured.spender, options);
  return buildTokenApprovalPlan({ ...captured, currentAllowance: allowance });
}

const permitInterface = new Interface([
  'function nonces(address) view returns (uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function name() view returns (string)', 'function version() view returns (string)',
  'function eip712Domain() view returns (bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)',
]);
export interface PermitProbeOptions extends Omit<ContractReadOptions, 'blockTag'> {
  chainId: bigint;
  /** A fixed block number prevents nonce/domain reads from mixing latest blocks. */
  blockTag: number;
  /** Used only if version() is absent; every candidate must match DOMAIN_SEPARATOR. */
  versionCandidates?: readonly string[];
}
export interface VerifiedPermitDomain {
  supported: true; token: Hex; owner: Hex; nonce: bigint; chainId: bigint; blockNumber: number;
  domain: { name: string; version: string; chainId: bigint; verifyingContract: Hex }; domainSeparator: Hex;
}
export type PermitProbe = VerifiedPermitDomain | { supported: false; reason: 'missing-permit-reads' | 'unsupported-domain' | 'domain-mismatch' };

/**
 * Discover a standard EIP-2612 domain, proving it against the token's separator.
 * A successful probe is not proof of permit's type schema or signature acceptance;
 * simulate the signed permit/onboard call. DAI-style and salted domains are excluded.
 */
export async function probeTokenPermit(provider: Pick<Provider, 'call' | 'getNetwork'>, tokenAddress: string, ownerAddress: string, options: PermitProbeOptions): Promise<PermitProbe> {
  const token = address(tokenAddress), owner = address(ownerAddress), chainId = uint(options.chainId), blockNumber = options.blockTag;
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? 30_000, maxResponseBytes = options.maxResponseBytes ?? 65_536;
  if (options.versionCandidates !== undefined && (!Array.isArray(options.versionCandidates) || options.versionCandidates.length > 8)) throw new DaoShipsError('INVALID_ARGUMENT', 'Permit version candidates must be an array of at most eight values.');
  const versions = Array.from(options.versionCandidates ?? ['1']);
  if (chainId === 0n || BigInt(token) === 0n || BigInt(owner) === 0n || !Number.isSafeInteger(blockNumber) || blockNumber < 0
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1
    || versions.length < 1 || versions.length > 8 || versions.some(value => typeof value !== 'string' || value.length > 1000)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Permit discovery requires a chain, fixed block and valid resource bounds.');
  }
  const rpc = <T>(fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let settled = false;
    const finish = (ok: boolean, result: unknown) => {
      if (settled) return;
      if (ok && performance.now() >= deadline) { ok = false; result = new DaoShipsError('TIMEOUT', 'Permit discovery timed out.'); }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (ok) resolve(result as T); else reject(result);
    };
    const abort = () => finish(false, new DaoShipsError('ABORTED', 'Permit discovery cancelled.'));
    const timer = setTimeout(() => finish(false, new DaoShipsError('TIMEOUT', 'Permit discovery timed out.')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => settled ? undefined : fn()).then(value => finish(true, value), error => finish(false, error));
  });
  const network = async () => {
    let value;
    try { value = await rpc(() => provider.getNetwork()); }
    catch (cause) {
      if (cause instanceof DaoShipsError) throw cause;
      throw new DaoShipsError('CHAIN_ERROR', 'Permit network discovery failed.', {}, { cause });
    }
    if (value.chainId !== chainId) throw new DaoShipsError('CHAIN_MISMATCH', 'Permit provider chain differs from the expected chain.');
  };
  const read = async (method: string, args: unknown[] = []) => {
    let raw: string;
    try { raw = await rpc(() => provider.call({ to: token, from: owner, data: permitInterface.encodeFunctionData(method, args), blockTag: blockNumber })); }
    catch (cause) {
      if (cause instanceof DaoShipsError) throw cause;
      if (cause && typeof cause === 'object' && (cause as { code?: unknown }).code === 'CALL_EXCEPTION') return null;
      throw new DaoShipsError('CHAIN_ERROR', 'Permit discovery transport failed.', {}, { cause });
    }
    if (raw === '0x') return null;
    if (typeof raw !== 'string' || raw.length > maxResponseBytes * 2 + 2 || !/^0x(?:[\da-fA-F]{2})*$/.test(raw)) throw new DaoShipsError('INVALID_RESPONSE', 'Malformed or oversized permit response.');
    try {
      const result = permitInterface.decodeFunctionResult(method, raw);
      if (checkResultErrors(result).length) throw new Error('Deferred decode failure');
      return result;
    } catch (cause) { throw new DaoShipsError('INVALID_RESPONSE', 'Invalid permit ABI response.', {}, { cause }); }
  };
  await network();
  const [nonceData, separatorData] = await Promise.all([read('nonces', [owner]), read('DOMAIN_SEPARATOR')]);
  if (!nonceData || !separatorData) { await network(); return { supported: false, reason: 'missing-permit-reads' }; }
  const nonce = uint(nonceData[0] as bigint), domainSeparator = separatorData[0] as Hex;
  const disclosed = await read('eip712Domain');
  let candidates: { name: string; version: string; chainId: bigint; verifyingContract: Hex }[];
  if (disclosed) {
    if (disclosed[0] !== '0x0f' || disclosed[6].length !== 0 || disclosed[3] !== chainId || address(disclosed[4]) !== token) {
      await network(); return { supported: false, reason: 'unsupported-domain' };
    }
    candidates = [{ name: disclosed[1], version: disclosed[2], chainId, verifyingContract: token }];
  } else {
    const [name, version] = await Promise.all([read('name'), read('version')]);
    if (!name) { await network(); return { supported: false, reason: 'unsupported-domain' }; }
    candidates = (version ? [version[0] as string] : versions).map(value => ({ name: name[0] as string, version: value, chainId, verifyingContract: token }));
  }
  const domain = candidates.find(candidate => TypedDataEncoder.hashDomain(candidate).toLowerCase() === domainSeparator.toLowerCase());
  await network();
  if (!domain) return { supported: false, reason: 'domain-mismatch' };
  return Object.freeze({ supported: true, token, owner, nonce, chainId, blockNumber, domain: Object.freeze(domain), domainSeparator });
}

export function buildExternalPermitTypedData(probe: VerifiedPermitDomain, input: { spender: string; value: bigint; deadline: bigint }): {
  domain: TypedDataDomain; types: Record<string, TypedDataField[]>; value: Record<string, string | bigint>;
} {
  const token = address(probe.token), chainId = uint(probe.chainId);
  if (probe.supported !== true || chainId === 0n || address(probe.domain.verifyingContract) !== token || probe.domain.chainId !== chainId
    || TypedDataEncoder.hashDomain(probe.domain).toLowerCase() !== probe.domainSeparator.toLowerCase()) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Permit evidence does not match the token domain.');
  }
  return { domain: { ...probe.domain }, types: { Permit: [
    { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }, { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  ] }, value: { owner: address(probe.owner), spender: address(input.spender), value: uint(input.value), nonce: uint(probe.nonce), deadline: uint(input.deadline) } };
}
