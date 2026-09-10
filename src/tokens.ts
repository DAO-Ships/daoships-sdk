import type { TypedDataDomain, TypedDataField } from 'quais';
import { ContractClient, type ContractReadOptions, type ContractReadProvider } from './contracts.js';
import { DaoShipsError } from './errors.js';
import { address, uint } from './values.js';

function decimals(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new DaoShipsError('INVALID_ARGUMENT', 'Token decimals must be an integer from 0 to 255.');
  return value;
}
/** Decimal parsing with no floating point conversion, exponent notation or rounding. */
export function parseTokenAmount(value: string, tokenDecimals: number): bigint {
  decimals(tokenDecimals);
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value) || (value.split('.')[1]?.length ?? 0) > tokenDecimals) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Amount must be a nonnegative decimal string within the token precision.');
  }
  try {
    const [whole = '0', fractional = ''] = value.split('.');
    if (whole.replace(/^0+/, '').length > 78) throw new DaoShipsError('INVALID_ARGUMENT', 'Amount exceeds uint256.');
    return uint(BigInt(whole) * 10n ** BigInt(tokenDecimals) + BigInt(fractional.padEnd(tokenDecimals, '0') || '0'));
  }
  catch (cause) { throw new DaoShipsError('INVALID_ARGUMENT', 'Amount exceeds the token integer range.', {}, { cause }); }
}
export function formatTokenAmount(value: bigint, tokenDecimals: number): string {
  uint(value); decimals(tokenDecimals);
  if (tokenDecimals === 0) return value.toString();
  const digits = value.toString().padStart(tokenDecimals + 1, '0');
  return `${digits.slice(0, -tokenDecimals)}.${digits.slice(-tokenDecimals).replace(/0+$/, '') || '0'}`;
}

/** ERC20 metadata plus complete SharesERC20 methods (loot supports the ERC20 subset). */
export class DaoShipsToken extends ContractClient<'SharesERC20'> {
  constructor(target: string, provider?: ContractReadProvider) { super('SharesERC20', target, provider); }
  async metadata(options?: ContractReadOptions) {
    const [name, symbol, rawDecimals, totalSupply] = await Promise.all([
      this.read('name', [], options), this.read('symbol', [], options),
      this.read('decimals', [], options), this.read('totalSupply', [], options),
    ]);
    return { address: this.address, name, symbol, decimals: decimals(Number(rawDecimals)), totalSupply };
  }
  balanceOf(account: string, options?: ContractReadOptions) { return this.read('balanceOf', [address(account)], options); }
  allowance(owner: string, spender: string, options?: ContractReadOptions) { return this.read('allowance', [address(owner), address(spender)], options); }
  transfer(to: string, amount: bigint) { return this.encode('transfer', [address(to), uint(amount)]); }
  approve(spender: string, amount: bigint) { return this.encode('approve', [address(spender), uint(amount)]); }
  delegate(to: string) { return this.encode('delegate', [address(to)]); }
}

/** Clone-safe EIP-2612 data: name and nonce must be read from this token clone. */
export function buildPermitTypedData(input: {
  token: string; name: string; chainId: bigint; owner: string; spender: string; value: bigint; nonce: bigint; deadline: bigint;
}): { domain: TypedDataDomain; types: Record<string, TypedDataField[]>; value: Record<string, string | bigint> } {
  if (typeof input.name !== 'string' || !input.name || uint(input.chainId) === 0n) throw new DaoShipsError('INVALID_ARGUMENT', 'Permit requires the clone token name and nonzero chain ID.');
  return {
    domain: { name: input.name, version: '1', chainId: input.chainId, verifyingContract: address(input.token) },
    types: { Permit: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }] },
    value: { owner: address(input.owner), spender: address(input.spender), value: uint(input.value),
      nonce: uint(input.nonce), deadline: uint(input.deadline) },
  };
}
