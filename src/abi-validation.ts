import type { ParamType } from 'quais';
import { DaoShipsError } from './errors.js';
import { address, hex } from './values.js';

/** Aggregate bounds protect encoders fed by untrusted JSON. Raise explicitly for larger calls. */
export interface AbiInputLimits { maxBytes?: number; maxItems?: number }
export const DEFAULT_ABI_INPUT_LIMITS = Object.freeze({ maxBytes: 1_048_576, maxItems: 10_000 });

export function normalizeAbiArguments(params: readonly ParamType[], input: unknown, limits: AbiInputLimits = {}): readonly unknown[] {
  const maxBytes = limits.maxBytes ?? DEFAULT_ABI_INPUT_LIMITS.maxBytes;
  const maxItems = limits.maxItems ?? DEFAULT_ABI_INPUT_LIMITS.maxItems;
  if (![maxBytes, maxItems].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'ABI input limits must be positive safe integers.');
  }
  let bytes = 0, items = 0;
  function fail(message: string): never { throw new DaoShipsError('INVALID_ARGUMENT', message); }
  function at(values: unknown[], i: number): unknown {
    const property = Object.getOwnPropertyDescriptor(values, String(i));
    if (!property || !Object.hasOwn(property, 'value')) fail('ABI arrays must be dense data arrays without accessors.');
    return property.value;
  }
  function normalize(param: ParamType, value: unknown, depth: number): unknown {
    if (++items > maxItems || depth > 32) fail('ABI input exceeds item or nesting limits.');
    if (param.baseType === 'array') {
      if (!Array.isArray(value) || (param.arrayLength !== -1 && value.length !== param.arrayLength)) fail('Expected an array with the ABI-defined length.');
      if (value.length > maxItems - items) fail('ABI input exceeds item limits.');
      return Array.from({ length: value.length }, (_, i) => normalize(param.arrayChildren!, at(value, i), depth + 1));
    }
    if (param.baseType === 'tuple') {
      if (!Array.isArray(value) || value.length !== param.components!.length) fail('Expected a positional ABI tuple.');
      return param.components!.map((component, i) => normalize(component, at(value, i), depth + 1));
    }
    if (param.type.startsWith('uint') || param.type.startsWith('int')) {
      const signed = param.type.startsWith('int');
      const bits = BigInt(param.type.slice(signed ? 3 : 4) || '256');
      const min = signed ? -(1n << (bits - 1n)) : 0n;
      const max = signed ? 1n << (bits - 1n) : 1n << bits;
      if (typeof value !== 'bigint' || value < min || value >= max) fail(`Expected ${param.type} as an in-range bigint.`);
      return value;
    }
    if (param.type === 'bool') {
      if (typeof value !== 'boolean') fail('Expected an actual boolean, not a truthy value.');
      return value;
    }
    if (param.type === 'address') {
      if (typeof value !== 'string') fail('Expected an address string.');
      return address(value);
    }
    if (typeof value !== 'string') fail(`Expected ${param.type} as a string.`);
    // Cheap bound before encoding/regex allocation, followed by actual UTF-8 or byte length.
    if (value.length > maxBytes * 2 + 2) fail('ABI input exceeds byte limits.');
    if (param.type === 'string') bytes += new TextEncoder().encode(value).length;
    else if (param.type.startsWith('bytes')) {
      hex(value);
      const length = (value.length - 2) / 2;
      if (param.type !== 'bytes' && length !== Number(param.type.slice(5))) fail(`Expected exactly ${param.type}.`);
      bytes += length;
    } else fail(`Unsupported ABI type ${param.type}.`);
    if (bytes > maxBytes) fail('ABI input exceeds byte limits.');
    return value;
  }
  if (!Array.isArray(input) || input.length !== params.length) fail('ABI argument count does not match the selected method.');
  return params.map((param, index) => normalize(param, at(input, index), 0));
}
