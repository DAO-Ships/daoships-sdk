import { DaoShipsError } from './errors.js';

export interface DataReadOptions { signal?: AbortSignal; timeoutMs?: number }
export function positive(value: number, name: string, max = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new DaoShipsError('INVALID_ARGUMENT', `${name} must be a positive integer at most ${max}.`);
  return value;
}
export async function bounded<T>(work: (signal: AbortSignal) => Promise<T>, options: DataReadOptions): Promise<T> {
  const timeoutMs = positive(options.timeoutMs ?? 30_000, 'timeoutMs');
  const external = options.signal, controller = new AbortController();
  const started = performance.now();
  const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let abort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error('Data read interrupted.')); signal.addEventListener('abort', abort, { once: true }); });
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(signal); }), cancelled]);
    if (performance.now() - started >= timeoutMs) controller.abort();
    signal.throwIfAborted();
    return result;
  } catch (cause) {
    if (external?.aborted) throw new DaoShipsError('ABORTED', 'Data integration cancelled.');
    if (controller.signal.aborted) throw new DaoShipsError('TIMEOUT', 'Data integration deadline elapsed.', { timeoutMs });
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('INDEXER_ERROR', 'Data integration failed.', {}, { cause });
  } finally { clearTimeout(timer); if (abort) signal.removeEventListener('abort', abort); controller.abort(); }
}

export async function streamedBytes(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new DaoShipsError('INDEXER_ERROR', 'HTTP request failed.', { status: response.status }); }
  if (!response.body) throw new DaoShipsError('INVALID_RESPONSE', 'Response has no streamed body.');
  const advertised = response.headers.get('content-length');
  if (advertised && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) { void response.body.cancel().catch(() => {}); throw new DaoShipsError('INVALID_RESPONSE', 'Response exceeds the byte limit.'); }
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  let length = 0, chunks = 0;
  let bytes = new Uint8Array(0);
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      const nextLength = length + value.byteLength;
      if (nextLength > maxBytes) throw new DaoShipsError('INVALID_RESPONSE', 'Response exceeds the byte limit.');
      if (nextLength > bytes.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(4096, bytes.length * 2, nextLength)));
        grown.set(bytes.subarray(0, length)); bytes = grown;
      }
      // Copy now: transports may reuse buffers, and tiny chunks must not retain
      // an unbounded number of objects alongside an otherwise bounded payload.
      bytes.set(value, length); length = nextLength;
      // An in-memory stream can otherwise keep scheduling microtasks forever,
      // starving the timers that deliver cancellation (even with empty chunks).
      if (++chunks % 1024 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return bytes.subarray(0, length);
  } finally { signal.removeEventListener('abort', abort); void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export async function streamedJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  const bytes = await streamedBytes(response, maxBytes, signal);
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new DaoShipsError('INVALID_RESPONSE', 'Response is not valid UTF-8 JSON.'); }
}
