import { getAddress } from 'quais';
import { DaoShipsError } from './errors.js';

export type Hex = `0x${string}`;

export function address(value: string): Hex {
  try { return getAddress(value) as Hex; }
  catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a checksummed or lowercase 20-byte address.'); }
}

export function hex(value: string): Hex {
  if (typeof value !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(value)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected even-length 0x-prefixed bytes.');
  }
  return value as Hex;
}

export function uint(value: bigint, bits = 256): bigint {
  if (!Number.isInteger(bits) || bits < 1 || bits > 256) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Integer width must be from 1 to 256 bits.');
  }
  if (typeof value !== 'bigint' || value < 0n || value >= (1n << BigInt(bits))) {
    throw new DaoShipsError('INVALID_ARGUMENT', `Expected a uint${bits} bigint.`);
  }
  return value;
}

export function proposalId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffffffff) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Proposal ID must be an integer from 1 to 4294967295.');
  }
  return value;
}

export function stringify(value: unknown, space?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, space);
}
