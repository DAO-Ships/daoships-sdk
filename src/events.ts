import { Interface, checkResultErrors, type ErrorDescription } from 'quais';
import { CONTRACT_ABIS, type ContractName } from './abis.js';
import type { ContractEvents } from './contract-types.js';
import type { Receipt } from './receipts.js';
import { DaoShipsError } from './errors.js';
import { address } from './values.js';

export type { ContractEvents } from './contract-types.js';
export type ContractEventName<K extends ContractName> = keyof ContractEvents[K] & string;
// Readers that never decode events should not construct all 17 contract interfaces.
const interfaces: Partial<Record<ContractName, Interface>> = {};
function contractInterface(name: ContractName): Interface {
  return interfaces[name] ??= new Interface(CONTRACT_ABIS[name]);
}
export interface EventDecodeOptions { maxLogs?: number; maxDataBytes?: number }

/** Typed event decoding verifies the emitting address and exact event signature. */
export function parseContractEvents<K extends ContractName, E extends ContractEventName<K>>(
  receipt: Receipt, contract: K, emitter: string, event: E, options: EventDecodeOptions = {},
): Array<{ name: string; signature: string; args: ContractEvents[K][E] }> {
  if (!receipt || !Array.isArray(receipt.logs)) throw new DaoShipsError('INVALID_RESPONSE', 'Expected a receipt with a log array.');
  if (receipt.status === 0) throw new DaoShipsError('TX_REVERTED', 'Transaction reverted on-chain.');
  if (receipt.status !== 1) throw new DaoShipsError('TX_PENDING', 'Receipt status is unknown.');
  if (typeof contract !== 'string' || !Object.hasOwn(CONTRACT_ABIS, contract)) throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown contract interface.');
  const maxLogs = options.maxLogs ?? 10_000, maxDataBytes = options.maxDataBytes ?? 4_194_304;
  if (![maxLogs, maxDataBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new DaoShipsError('INVALID_ARGUMENT', 'Event decode limits must be positive safe integers.');
  if (receipt.logs.length > maxLogs) throw new DaoShipsError('INVALID_RESPONSE', 'Receipt exceeds the log limit.');
  const expected = address(emitter).toLowerCase();
  const iface = contractInterface(contract);
  let fragment;
  try { fragment = typeof event === 'string' ? iface.getEvent(event) : null; }
  catch (cause) { throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an unambiguous contract event.', {}, { cause }); }
  if (!fragment) throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown contract event.');
  const signature = fragment.format('sighash');
  const topicHash = fragment.topicHash.toLowerCase();
  let bytes = 0;
  return receipt.logs.flatMap(log => {
    if (typeof log?.address !== 'string' || log.address.toLowerCase() !== expected) return [];
    if (typeof log.data !== 'string' || !Array.isArray(log.topics) || log.topics.length > 4) return [];
    bytes += Math.max(0, Math.ceil((log.data.length - 2) / 2));
    if (bytes > maxDataBytes) throw new DaoShipsError('INVALID_RESPONSE', 'Receipt exceeds the event data limit.');
    if (!/^0x(?:[\da-fA-F]{2})*$/.test(log.data)) return [];
    if (!log.topics.every((topic: unknown) => typeof topic === 'string' && /^0x[\da-fA-F]{64}$/.test(topic))) return [];
    if (!fragment.anonymous && log.topics[0]?.toLowerCase() !== topicHash) return [];
    try {
      const parsed = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed || parsed.signature !== signature || checkResultErrors(parsed.args).length) return [];
      return [{ name: parsed.name, signature: parsed.signature, args: parsed.args as unknown as ContractEvents[K][E] }];
    } catch { return []; }
  });
}

export interface DecodedRevert {
  name: string; signature: string; selector: string; args: readonly unknown[];
  /** Same selector may be shared by several contracts; this is not proof of the emitter. */
  contracts: readonly string[];
}
const standardErrors = new Interface(['error Error(string)', 'error Panic(uint256)']);
let errorInterfaces: { contract: ContractName; iface: Interface; selectors: Set<string> }[] | undefined;
function customErrorInterfaces() {
  return errorInterfaces ??= (Object.keys(CONTRACT_ABIS) as ContractName[]).map(contract => {
    const iface = contractInterface(contract);
    return { contract, iface, selectors: new Set(iface.fragments.filter(fragment => fragment.type === 'error').map(fragment => iface.getError(fragment.format('sighash'))!.selector)) };
  });
}
export interface RevertDecodeOptions { maxBytes?: number; maxNodes?: number }

/** Accept raw revert bytes or common nested RPC/quais error objects; unknown selectors return null. */
export function decodeRevert(input: unknown, options: RevertDecodeOptions = {}): DecodedRevert | null {
  const maxBytes = options.maxBytes ?? 65_536, maxNodes = options.maxNodes ?? 64;
  if (![maxBytes, maxNodes].every(value => Number.isSafeInteger(value) && value > 0)) throw new DaoShipsError('INVALID_ARGUMENT', 'Revert decode limits must be positive safe integers.');
  const visited = new Set<object>();
  const candidates: string[] = [];
  function collect(value: unknown, depth: number): void {
    if (depth > 6 || visited.size >= maxNodes || candidates.length >= 16) return;
    if (typeof value === 'string') {
      if (value.length <= maxBytes * 2 + 2 && /^0x(?:[\da-fA-F]{2}){4,}$/.test(value)) candidates.push(value);
      return;
    }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    for (const key of ['data', 'error', 'info', 'cause', 'originalError']) {
      try {
        const property = Object.getOwnPropertyDescriptor(value, key);
        if (property && Object.hasOwn(property, 'value')) collect(property.value, depth + 1);
      } catch { /* Ignore hostile proxies/accessors in diagnostic error objects. */ }
    }
  }
  collect(input, 0);
  for (const data of candidates) {
    const matches: { contract: string; error: ErrorDescription }[] = [];
    const selector = data.slice(0, 10).toLowerCase();
    try {
      const standard = standardErrors.parseError(data);
      if (standard && !checkResultErrors(standard.args).length) return { name: standard.name, signature: standard.signature,
        selector: standard.selector, args: [...standard.args], contracts: ['Solidity'] };
    } catch { /* Try custom errors. */ }
    for (const { contract, iface, selectors } of customErrorInterfaces()) {
      if (!selectors.has(selector)) continue;
      try {
        const error = iface.parseError(data);
        if (error && !checkResultErrors(error.args).length) matches.push({ contract, error });
      } catch { /* Try other ABI dictionaries. */ }
    }
    const first = matches[0];
    if (first) return { name: first.error.name, signature: first.error.signature, selector: first.error.selector,
      args: [...first.error.args], contracts: matches.filter(match => match.error.signature === first.error.signature).map(match => match.contract) };
  }
  return null;
}
