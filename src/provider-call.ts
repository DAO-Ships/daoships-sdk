import type { TransactionRequest } from 'quais';
import type { ContractReadOptions, ContractReadProvider } from './contracts.js';
import { DaoShipsError } from './errors.js';

/** Shared bounded eth_call transport. Provider resources remain caller-owned. */
export async function callProvider(provider: ContractReadProvider, request: TransactionRequest, options: ContractReadOptions = {}): Promise<string> {
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? 30_000, maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 1) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Contract timeout and response byte bounds must be positive integers.');
  }
  const deadline = performance.now() + timeoutMs;
  let raw: string;
  try {
    raw = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (ok: boolean, result: unknown) => {
        if (settled) return;
        if (ok && (signal?.aborted || performance.now() >= deadline)) {
          ok = false;
          result = new DaoShipsError(signal?.aborted ? 'ABORTED' : 'TIMEOUT', 'Contract call exceeded its cancellation or deadline boundary.');
        }
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (ok) resolve(result as string); else reject(result);
      };
      const abort = () => finish(false, new DaoShipsError('ABORTED', 'Contract call cancelled.'));
      const timer = setTimeout(() => finish(false, new DaoShipsError('TIMEOUT', 'Contract call timed out.')), timeoutMs);
      if (signal?.aborted) { abort(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      Promise.resolve().then(() => settled ? undefined : provider.call(request)).then(value => finish(true, value), cause => finish(false, cause));
    });
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('CHAIN_ERROR', 'Contract provider call failed.', {}, { cause });
  }
  if (signal?.aborted || performance.now() >= deadline) throw new DaoShipsError(signal?.aborted ? 'ABORTED' : 'TIMEOUT', 'Contract call exceeded its cancellation or deadline boundary.');
  if (typeof raw !== 'string' || raw.length > maxResponseBytes * 2 + 2 || !/^0x(?:[\da-fA-F]{2})*$/.test(raw)) {
    throw new DaoShipsError('INVALID_RESPONSE', 'Contract response is malformed or exceeds the byte limit.');
  }
  return raw;
}
