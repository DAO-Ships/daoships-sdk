import { Interface, ZeroAddress, checkResultErrors, type BlockTag, type Provider } from 'quais';
import { CONTRACT_ABIS } from './abis.js';
import { DaoShipsError } from './errors.js';
import { address, hex, uint, type Hex } from './values.js';
import { normalizeAbiArguments } from './abi-validation.js';
import type { ContractReadOptions } from './contracts.js';
import { callProvider } from './provider-call.js';
import { parseContractEvents, type EventDecodeOptions } from './events.js';
import type { NavigatorDeployConfig, NavigatorKind, NavigatorReads, NavigatorReadResults, NavigatorWrites } from './navigators-types.js';
export type { NavigatorDeployConfig, NavigatorKind, NavigatorReads, NavigatorReadResults, NavigatorWrites } from './navigators-types.js';

export const NAVIGATOR_KINDS = Object.freeze(['OnboarderNavigator', 'ERC20TributeNavigator', 'NFTGatedNavigator', 'SignalNavigator', 'TimelockNavigator', 'VestingNavigator', 'BudgetNavigator', 'SubscriptionNavigator'] as const);
export const NAVIGATOR_LIMITS = Object.freeze({ minPeriod: 3600n, maxPeriod: 315360000n, maxCollectorRewardBps: 1000n,
  minTimelockDelay: 600n, recommendedTimelockDelay: 172800n, maxTimelockDelay: 2592000n,
  minTimelockExpiry: 3600n, maxWindow: 315360000n, minPollOptions: 2n, maxPollOptions: 10n } as const);
export enum SignalPollStatus { Pending, Active, Ended, Cancelled }
export interface NavigatorCall { to: Hex; data: Hex; value: bigint; operation: string }
export interface NavigatorReadOptions extends ContractReadOptions {}
const ZERO = '0x0000000000000000000000000000000000000000';
function requireConfig(condition: unknown, message: string): asserts condition {
  if (!condition) throw new DaoShipsError('INVALID_ARGUMENT', message);
}
function iface(kind: NavigatorKind): Interface {
  requireConfig(NAVIGATOR_KINDS.includes(kind), 'Unknown navigator kind.');
  return new Interface(CONTRACT_ABIS[kind]);
}
function methodFragment(contract: Interface, method: string) {
  try { return contract.getFunction(method); }
  catch (cause) { throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown or ambiguous navigator method.', {}, { cause }); }
}

function validateWrite(kind: NavigatorKind, method: string, args: readonly unknown[]): void {
  if (kind === 'SignalNavigator' && method === 'createPoll') {
    requireConfig((args[1] as bigint) >= 2n && (args[1] as bigint) <= 10n && (args[3] as bigint) > 0n, 'Poll requires 2 to 10 options and a positive duration.');
    uint((args[2] as bigint) + (args[3] as bigint), 64);
  } else if (kind === 'VestingNavigator' && method === 'createSchedule') {
    requireConfig(address(args[0] as string) !== ZERO && (args[1] as bigint) > 0n, 'Schedule requires a beneficiary and positive total amount.');
    requireConfig((args[4] as bigint) > 0n && (args[3] as bigint) <= (args[4] as bigint), 'Cliff must not exceed positive vesting duration.');
    uint((args[2] as bigint) + (args[4] as bigint), 64);
  } else if (kind === 'BudgetNavigator' && method === 'createBudget') {
    requireConfig(address(args[0] as string) !== ZERO && (args[2] as bigint) > 0n && (args[3] as bigint) > 0n, 'Budget needs a manager, positive allowance and positive ceiling.');
    requireConfig((args[4] as bigint) >= 3600n && (args[4] as bigint) <= 315360000n, 'Budget period must be 1 hour to 3650 days.');
    requireConfig(args[6] === 0n || (args[6] as bigint) > (args[5] as bigint), 'Budget end must be after start.');
  } else if (kind === 'BudgetNavigator' && method === 'disburseBatch') {
    const recipients = args[1] as readonly string[], amounts = args[2] as readonly bigint[];
    requireConfig(recipients.length > 0 && recipients.length === amounts.length, 'Disbursement recipients and amounts must be nonempty and aligned.');
  } else if (kind === 'SubscriptionNavigator' && (method === 'payFee' || method === 'payFeeFor')) {
    requireConfig((args[method === 'payFee' ? 0 : 1] as bigint) > 0n, 'Payment periods must be positive.');
  }
}

/** Named constructor arguments, with local Solidity configuration invariants checked. */
export function navigatorDeploymentArgs<K extends NavigatorKind>(kind: K, config: NavigatorDeployConfig[K]): readonly unknown[] {
  const inputs = iface(kind).deploy.inputs;
  requireConfig(config && typeof config === 'object' && !Array.isArray(config), 'Expected navigator configuration object.');
  const fields = config as unknown as Record<string, unknown>;
  const args = normalizeAbiArguments(inputs, inputs.map(input => {
    const descriptor = Object.getOwnPropertyDescriptor(fields, input.name.replace(/^_/, ''));
    requireConfig(descriptor && Object.hasOwn(descriptor, 'value'), 'Navigator configuration requires own data properties.');
    return descriptor.value as unknown;
  }));
  config = Object.fromEntries(inputs.map((input, i) => [input.name.replace(/^_/, ''), args[i]])) as unknown as NavigatorDeployConfig[K];
  requireConfig(address(config.daoShip) !== ZERO, 'daoShip cannot be zero.');
  if (kind === 'OnboarderNavigator') {
    const c = config as NavigatorDeployConfig['OnboarderNavigator'];
    requireConfig((c.shareMultiplier > 0n || c.lootMultiplier > 0n) !== (c.pricePerUnit > 0n), 'Choose exactly one pricing mode.');
    requireConfig(c.pricePerUnit === 0n || c.sharesPerUnit + c.lootPerUnit > 0n, 'Fixed pricing must mint shares or loot.');
  } else if (kind === 'ERC20TributeNavigator') {
    const c = config as NavigatorDeployConfig['ERC20TributeNavigator'];
    requireConfig(address(c.tributeToken) !== ZERO && c.pricePerShare + c.pricePerLoot > 0n, 'A tribute token and at least one positive price are required.');
  } else if (kind === 'NFTGatedNavigator') {
    const c = config as NavigatorDeployConfig['NFTGatedNavigator']; const minted = uint(c.sharesPerHolder + c.lootPerHolder);
    requireConfig(address(c.gateToken) !== ZERO && minted > 0n, 'An NFT gate and positive mint amount are required.');
    requireConfig(c.requireTribute === (c.tributeAmount > 0n), 'Tribute flag must match amount.');
    requireConfig(c.mintCap >= minted && (c.perAddressCap === 0n || c.perAddressCap >= minted), 'Each claim must fit within mint caps.');
  } else if (kind === 'SignalNavigator') {
    const c = config as NavigatorDeployConfig['SignalNavigator'];
    requireConfig(c.minDuration > 0n && c.maxDuration >= c.minDuration && c.maxDuration <= NAVIGATOR_LIMITS.maxWindow && c.maxStartDelay <= NAVIGATOR_LIMITS.maxWindow, 'Invalid poll duration or start delay.');
  } else if (kind === 'TimelockNavigator') {
    const c = config as NavigatorDeployConfig['TimelockNavigator'];
    requireConfig(c.delay >= 600n && c.delay <= 2592000n && c.expiryWindow >= 3600n && c.expiryWindow <= 315360000n, 'Invalid timelock delay or expiry window.');
  } else if (kind === 'SubscriptionNavigator') {
    const c = config as NavigatorDeployConfig['SubscriptionNavigator'];
    requireConfig(c.periodDuration >= 3600n && c.periodDuration <= 315360000n && c.graceDuration <= 315360000n && c.collectorRewardBps <= 1000n, 'Invalid subscription period, grace, or collector reward.');
    requireConfig(c.tokens.length > 0 && c.tokens.length === c.feesPerPeriod.length && c.feesPerPeriod.every(f => f > 0n), 'Tokens and positive fees must be nonempty and aligned.');
    requireConfig(new Set(c.tokens.map(t => address(t).toLowerCase())).size === c.tokens.length, 'Duplicate subscription tokens.');
    requireConfig(c.initialMembers.every(m => address(m) !== ZERO) && new Set(c.initialMembers.map(m => address(m).toLowerCase())).size === c.initialMembers.length, 'Initial members must be nonzero and unique.');
  }
  return args;
}

/** Caller supplies audited creation bytecode; no provider, signer or broadcast is involved. */
export function encodeNavigatorDeployment<K extends NavigatorKind>(kind: K, bytecode: string, config: NavigatorDeployConfig[K]): Hex {
  const code = hex(bytecode); requireConfig(code !== '0x', 'Creation bytecode cannot be empty.');
  return hex(code + iface(kind).encodeDeploy(navigatorDeploymentArgs(kind, config)).slice(2));
}

/** Typed access to every navigator read, mutation and overload. Encoded writes are unsigned. */
export class Navigator<K extends NavigatorKind> {
  readonly address: Hex;
  readonly interface: Interface;
  constructor(readonly kind: K, target: string, private readonly runner?: Pick<Provider, 'call'>) {
    this.address = address(target); this.interface = iface(kind);
  }
  encode<M extends keyof NavigatorWrites[K] & string>(method: M, args: NavigatorWrites[K][M], value = 0n): NavigatorCall {
    const fragment = methodFragment(this.interface, method);
    requireConfig(fragment && fragment.stateMutability !== 'view' && fragment.stateMutability !== 'pure', 'Expected navigator write method.');
    const normalized = normalizeAbiArguments(fragment.inputs, args);
    validateWrite(this.kind, fragment.name, normalized);
    uint(value); requireConfig(value === 0n || fragment.payable, 'Cannot send native value to a nonpayable method.');
    try { return { to: this.address, data: this.interface.encodeFunctionData(fragment, normalized) as Hex, value, operation: fragment.format() }; }
    catch (cause) { throw new DaoShipsError('INVALID_ARGUMENT', `Invalid ${this.kind}.${method} arguments.`, {}, { cause }); }
  }
  async read<M extends keyof NavigatorReads[K] & keyof NavigatorReadResults[K] & string>(method: M, args: NavigatorReads[K][M], options: NavigatorReadOptions = {}): Promise<NavigatorReadResults[K][M]> {
    requireConfig(this.runner, 'A contract runner is required for reads.');
    const fragment = methodFragment(this.interface, method);
    requireConfig(fragment && (fragment.stateMutability === 'view' || fragment.stateMutability === 'pure'), 'Expected navigator read method.');
    const normalized = normalizeAbiArguments(fragment.inputs, args, options);
    const request = { to: this.address, from: address(options.from ?? ZeroAddress), data: this.interface.encodeFunctionData(fragment, normalized), ...(options.blockTag === undefined ? {} : { blockTag: options.blockTag }) };
    const raw = await callProvider(this.runner, request, options);
    try {
      const decoded = this.interface.decodeFunctionResult(fragment, raw);
      if (checkResultErrors(decoded).length) throw new DaoShipsError('INVALID_RESPONSE', 'Navigator response contains invalid ABI values.');
      return (fragment.outputs.length === 1 ? decoded[0] : decoded.toArray()) as NavigatorReadResults[K][M];
    } catch (cause) { throw new DaoShipsError('INVALID_RESPONSE', `Invalid navigator ABI response: ${method}.`, { to: this.address }, { cause }); }
  }
  /** Simulate the exact sender/value payload before passing it to a wallet. */
  async simulate<M extends keyof NavigatorWrites[K] & string>(method: M, args: NavigatorWrites[K][M], from: string, value = 0n, blockTag?: BlockTag, options: Omit<ContractReadOptions, 'from' | 'blockTag'> = {}): Promise<NavigatorCall> {
    requireConfig(this.runner, 'A contract runner is required for simulation.');
    const tx = this.encode(method, args, value); const sender = address(from);
    await callProvider(this.runner, { to: tx.to, data: tx.data, value: tx.value, from: sender, ...(blockTag === undefined ? {} : { blockTag }) }, options);
    return tx;
  }
}

export function quoteOnboarder(config: Pick<NavigatorDeployConfig['OnboarderNavigator'], 'shareMultiplier' | 'lootMultiplier' | 'pricePerUnit' | 'sharesPerUnit' | 'lootPerUnit' | 'minTribute'>, value: bigint): { shares: bigint; loot: bigint; cost: bigint; refund: bigint } {
  [config.shareMultiplier, config.lootMultiplier, config.pricePerUnit, config.sharesPerUnit, config.lootPerUnit, config.minTribute].forEach(v => uint(v)); uint(value);
  requireConfig((config.shareMultiplier > 0n || config.lootMultiplier > 0n) !== (config.pricePerUnit > 0n), 'Choose exactly one pricing mode.');
  const fixed = config.pricePerUnit > 0n;
  requireConfig(value >= (fixed ? config.pricePerUnit : config.minTribute), 'Insufficient tribute.');
  const units = fixed ? value / config.pricePerUnit : 0n;
  const shares = fixed ? uint(units * config.sharesPerUnit) : uint(value * config.shareMultiplier) / 10000n;
  const loot = fixed ? uint(units * config.lootPerUnit) : uint(value * config.lootMultiplier) / 10000n;
  requireConfig(uint(shares + loot) > 0n, 'Tribute rounds to zero minted tokens.');
  const cost = fixed ? units * config.pricePerUnit : value;
  return { shares, loot, cost, refund: value - cost };
}
export function quoteERC20Tribute(shares: bigint, loot: bigint, pricePerShare: bigint, pricePerLoot: bigint): bigint {
  [shares, loot, pricePerShare, pricePerLoot].forEach(v => uint(v)); requireConfig(uint(shares + loot) > 0n, 'Must mint shares or loot.');
  const sharesCost = uint(shares * pricePerShare) / 10n ** 18n;
  const lootCost = uint(loot * pricePerLoot) / 10n ** 18n;
  requireConfig((shares === 0n || sharesCost > 0n) && (loot === 0n || lootCost > 0n), 'Requested token is disabled or tribute rounds to zero.');
  return uint(sharesCost + lootCost);
}

export interface NavigatorDeployment {
  navigatorAddress: Hex; daoShip: Hex; deployer: Hex; kind: NavigatorKind; name: string; description: string;
}
/** Validate constructor provenance from the expected emitting contract, not arbitrary matching logs. */
export function parseNavigatorDeploymentReceipt(
  receipt: import('./receipts.js').Receipt,
  navigatorAddress: string,
  expected: { daoShip?: string; deployer?: string; kind?: NavigatorKind } = {},
  options: EventDecodeOptions = {},
): NavigatorDeployment {
  const target = address(navigatorAddress);
  const matches = parseContractEvents(receipt, 'OnboarderNavigator', target, 'NavigatorDeployed', options);
  if (matches.length !== 1) throw new DaoShipsError('MISSING_EVENT', 'Expected exactly one NavigatorDeployed event from this navigator.');
  const args = matches[0]!.args;
  const result = { navigatorAddress: target, daoShip: address(args.daoShip), deployer: address(args.deployer),
    kind: args.navigatorType as NavigatorKind, name: args.name as string, description: args.description as string };
  if (!NAVIGATOR_KINDS.includes(result.kind) || (expected.kind !== undefined && expected.kind !== result.kind) ||
    (expected.daoShip !== undefined && address(expected.daoShip).toLowerCase() !== result.daoShip.toLowerCase()) ||
    (expected.deployer !== undefined && address(expected.deployer).toLowerCase() !== result.deployer.toLowerCase())) {
    throw new DaoShipsError('INVALID_RESPONSE', 'Navigator deployment event does not match expected configuration.');
  }
  return result;
}
