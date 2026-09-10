import { Interface, checkResultErrors, type BlockTag, type Provider, type FunctionFragment } from 'quais';
import { CONTRACT_ABIS, type ContractName } from './abis.js';
import type { ContractMethods } from './contract-types.js';
import { DaoShipsError } from './errors.js';
import { address, uint, type Hex } from './values.js';
import { normalizeAbiArguments, type AbiInputLimits } from './abi-validation.js';
import { callProvider } from './provider-call.js';
export type { AbiInputLimits } from './abi-validation.js';

export type { ContractMethods } from './contract-types.js';
export type ContractMethod<K extends ContractName> = keyof ContractMethods[K] & string;
type Info<K extends ContractName, M extends ContractMethod<K>> = ContractMethods[K][M];
export type ContractArgs<K extends ContractName, M extends ContractMethod<K>> = Info<K, M> extends { args: infer A } ? A : never;
export type ContractResult<K extends ContractName, M extends ContractMethod<K>> = Info<K, M> extends { result: infer R } ? R : never;
export type ReadMethod<K extends ContractName> = { [M in ContractMethod<K>]:
  Info<K, M> extends { mutability: 'view' | 'pure' } ? M : never }[ContractMethod<K>];
export type WriteMethod<K extends ContractName> = Exclude<ContractMethod<K>, ReadMethod<K>>;
export type ContractReadProvider = Pick<Provider, 'call'>;
export interface ContractReadOptions extends AbiInputLimits {
  from?: string; blockTag?: BlockTag; signal?: AbortSignal;
  /** Bounds the SDK wait even if an injected provider never resolves. */
  timeoutMs?: number;
  maxResponseBytes?: number;
}
export interface EncodedCall { to: Hex; data: Hex; value: bigint; operation: string }

/** Complete typed ABI access, including overloads by their full Solidity signature. */
export class ContractClient<K extends ContractName> {
  readonly address: Hex;
  readonly interface: Interface;
  constructor(readonly name: K, target: string, private readonly provider?: ContractReadProvider) {
    if (typeof name !== 'string' || !Object.hasOwn(CONTRACT_ABIS, name)) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown contract interface.');
    }
    this.address = address(target);
    this.interface = new Interface(CONTRACT_ABIS[name]);
  }

  private fragment(method: string, read: boolean): FunctionFragment {
    try {
      if (typeof method !== 'string') throw new Error('Invalid method');
      const fragment = this.interface.getFunction(method);
      if (!fragment || ['view', 'pure'].includes(fragment.stateMutability) !== read) throw new Error('Invalid method kind');
      return fragment;
    } catch (cause) {
      throw new DaoShipsError('INVALID_ARGUMENT', `Expected an unambiguous ${read ? 'read' : 'transaction'} method.`, {}, { cause });
    }
  }

  async read<M extends ReadMethod<K>>(method: M, args: ContractArgs<K, M>, options: ContractReadOptions = {}): Promise<ContractResult<K, M>> {
    if (!this.provider) throw new DaoShipsError('CHAIN_ERROR', 'A provider is required for contract reads.');
    const fragment = this.fragment(method, true);
    const normalized = normalizeAbiArguments(fragment.inputs, args, options);
    const from = address(options.from ?? this.address);
    const request = { to: this.address, from, data: this.interface.encodeFunctionData(fragment, normalized),
      ...(options.blockTag !== undefined ? { blockTag: options.blockTag } : {}) };
    const raw = await callProvider(this.provider, request, options);
    try {
      const result = this.interface.decodeFunctionResult(fragment, raw);
      if (checkResultErrors(result).length) throw new DaoShipsError('INVALID_RESPONSE', 'Contract response contains invalid ABI values.');
      return (fragment.outputs.length === 1 ? result[0] : fragment.outputs.length ? result : undefined) as ContractResult<K, M>;
    } catch (cause) {
      if (cause instanceof DaoShipsError) throw cause;
      throw new DaoShipsError('INVALID_RESPONSE', `Invalid contract ABI response: ${this.name}.${method}.`, { contract: this.name, method }, { cause });
    }
  }

  encode<M extends WriteMethod<K>>(method: M, args: ContractArgs<K, M>, options: AbiInputLimits & { value?: bigint } = {}): EncodedCall {
    const fragment = this.fragment(method, false);
    const normalized = normalizeAbiArguments(fragment.inputs, args, options);
    const value = uint(options.value ?? 0n);
    if (fragment.stateMutability !== 'payable' && value !== 0n) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'A nonpayable method cannot receive native value.');
    }
    try {
      return { to: this.address, value, operation: method,
        data: this.interface.encodeFunctionData(fragment, normalized) as Hex };
    } catch (cause) {
      throw new DaoShipsError('INVALID_ARGUMENT', `Invalid arguments for ${this.name}.${method}.`, {}, { cause });
    }
  }
}
