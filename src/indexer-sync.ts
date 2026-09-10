import { DaoShipsError } from './errors.js';

/** Both compact and complete indexer state projections satisfy this interface. */
export interface IndexerCheckpoint {
  chain_id: number;
  last_block_number: bigint | string | number;
  last_indexed_at: string | null;
  is_syncing: boolean;
  requires_full_reindex: boolean;
  reindex_reason?: string | null;
}
export interface IndexerHealthOptions {
  chainId: number;
  /** Explicit chain head or minimum desired checkpoint. Never fetched implicitly. */
  expectedBlock?: bigint;
  /** Allowed lag behind expectedBlock; defaults to zero when expectedBlock is supplied. */
  maxBlockLag?: bigint;
  /** Explicit Unix time in milliseconds, required when enforcing maxAgeMs. */
  nowMs?: number;
  maxAgeMs?: number;
  /** Accepted timestamp lead over nowMs, allowing bounded clock skew; defaults to 60 seconds. */
  maxFutureSkewMs?: number;
}
export interface IndexerHealth {
  indexedBlock: bigint;
  blockLag: bigint | null;
  ageMs: number | null;
  /** Informational: actively indexing is not itself a health failure. */
  isSyncing: boolean;
}
export interface WaitForIndexedBlockOptions extends Omit<IndexerHealthOptions, 'expectedBlock' | 'maxBlockLag'> {
  timeoutMs?: number;
  pollIntervalMs?: number;
  signal?: AbortSignal;
}
export interface IndexerCheckpointReader<T extends IndexerCheckpoint = IndexerCheckpoint> {
  getStateDetails(signal?: AbortSignal): Promise<T | null>;
}
function nonnegativeBigint(value: bigint, name: string): bigint {
  if (typeof value !== 'bigint' || value < 0n) throw new DaoShipsError('INVALID_ARGUMENT', `${name} must be a nonnegative bigint.`);
  return value;
}
function validateOptions(options: IndexerHealthOptions): void {
  if (!Number.isSafeInteger(options.chainId) || options.chainId < 1) throw new DaoShipsError('INVALID_ARGUMENT', 'chainId must be a positive safe integer.');
  if (options.expectedBlock !== undefined) nonnegativeBigint(options.expectedBlock, 'expectedBlock');
  if (options.maxBlockLag !== undefined) {
    nonnegativeBigint(options.maxBlockLag, 'maxBlockLag');
    if (options.expectedBlock === undefined) throw new DaoShipsError('INVALID_ARGUMENT', 'maxBlockLag requires expectedBlock.');
  }
  for (const key of ['nowMs', 'maxAgeMs', 'maxFutureSkewMs'] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new DaoShipsError('INVALID_ARGUMENT', `${key} must be a nonnegative safe integer.`);
  }
  if (options.maxAgeMs !== undefined && options.nowMs === undefined) throw new DaoShipsError('INVALID_ARGUMENT', 'maxAgeMs requires explicit nowMs.');
  if (options.maxFutureSkewMs !== undefined && options.nowMs === undefined) throw new DaoShipsError('INVALID_ARGUMENT', 'maxFutureSkewMs requires explicit nowMs.');
}
function checkpointBlock(value: IndexerCheckpoint['last_block_number']): bigint {
  if (typeof value === 'bigint' && value >= 0n) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && value.length <= 78 && /^(0|[1-9]\d*)$/.test(value)) return BigInt(value);
  throw new DaoShipsError('INVALID_RESPONSE', 'Indexer checkpoint must contain an exact nonnegative block number.');
}
/** Reject unsafe checkpoints using explicit chain, block and clock expectations. */
export function assertIndexerHealthy(state: IndexerCheckpoint | null, options: IndexerHealthOptions): IndexerHealth {
  validateOptions(options);
  if (state === null) throw new DaoShipsError('INDEXER_ERROR', 'Indexer checkpoint is not initialized.', { reason: 'NOT_INITIALIZED' });
  if (!state || !Number.isSafeInteger(state.chain_id) || state.chain_id < 1 || typeof state.is_syncing !== 'boolean'
    || typeof state.requires_full_reindex !== 'boolean' || !(state.last_indexed_at === null || typeof state.last_indexed_at === 'string')
    || !(state.reindex_reason === undefined || state.reindex_reason === null || typeof state.reindex_reason === 'string')) {
    throw new DaoShipsError('INVALID_RESPONSE', 'Malformed indexer checkpoint.');
  }
  if (state.chain_id !== options.chainId) throw new DaoShipsError('CHAIN_MISMATCH', 'Indexer chain does not match the expected chain.', { expectedChainId: options.chainId, actualChainId: state.chain_id });
  if (state.requires_full_reindex) throw new DaoShipsError('INDEXER_ERROR', 'Indexer requires a full reindex before its checkpoint can be trusted.', { reason: 'REINDEX_REQUIRED', reindexReason: state.reindex_reason ?? null });
  const indexedBlock = checkpointBlock(state.last_block_number);
  let ageMs: number | null = null;
  if (state.last_indexed_at !== null) {
    if (!/^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(state.last_indexed_at)) {
      throw new DaoShipsError('INVALID_RESPONSE', 'Indexer checkpoint timestamp must include an ISO date, time and timezone.');
    }
    const indexedAt = Date.parse(state.last_indexed_at);
    if (!Number.isFinite(indexedAt)) throw new DaoShipsError('INVALID_RESPONSE', 'Indexer checkpoint contains an invalid timestamp.');
    if (options.nowMs !== undefined) {
      if (indexedAt - options.nowMs > (options.maxFutureSkewMs ?? 60_000)) {
        throw new DaoShipsError('INVALID_RESPONSE', 'Indexer checkpoint timestamp is ahead of the allowed clock skew.');
      }
      ageMs = Math.max(0, options.nowMs - indexedAt);
    }
  }
  if (options.maxAgeMs !== undefined && (ageMs === null || ageMs > options.maxAgeMs)) {
    throw new DaoShipsError('INDEXER_ERROR', 'Indexer checkpoint is stale or has no indexing timestamp.', { reason: 'STALE', ageMs, maxAgeMs: options.maxAgeMs });
  }
  const blockLag = options.expectedBlock === undefined ? null : options.expectedBlock > indexedBlock ? options.expectedBlock - indexedBlock : 0n;
  if (blockLag !== null && blockLag > (options.maxBlockLag ?? 0n)) {
    throw new DaoShipsError('INDEXER_ERROR', 'Indexer checkpoint is behind the expected block.', { reason: 'BEHIND', indexedBlock: indexedBlock.toString(), expectedBlock: options.expectedBlock!.toString(), blockLag: blockLag.toString(), maxBlockLag: (options.maxBlockLag ?? 0n).toString() });
  }
  return { indexedBlock, blockLag, ageMs, isSyncing: state.is_syncing };
}

/**
 * Wait for a healthy committed checkpoint at or beyond targetBlock. This confirms
 * indexer progress, not finality, transaction inclusion, or a particular entity row.
 * Missing/behind states are polled; transport, wrong-chain and reindex failures surface immediately.
 */
export async function waitForIndexedBlock<T extends IndexerCheckpoint>(
  indexer: IndexerCheckpointReader<T>, targetBlock: bigint, options: WaitForIndexedBlockOptions,
): Promise<T> {
  // Chain and freshness requirements remain fixed for the entire wait, even
  // when callers reuse and edit their options while an RPC is pending.
  options = { ...options };
  nonnegativeBigint(targetBlock, 'targetBlock');
  validateOptions(options);
  const timeoutMs = options.timeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  for (const [name, value] of [['timeoutMs', timeoutMs], ['pollIntervalMs', pollIntervalMs]] as const) {
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new DaoShipsError('INVALID_ARGUMENT', `${name} must be a positive 32-bit integer.`);
  }
  if (!indexer || typeof indexer.getStateDetails !== 'function') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an indexer checkpoint reader.');
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = performance.now();
  let lastBlock: bigint | null = null;
  let interrupt: (() => void) | undefined;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    signal.throwIfAborted();
    const cancelled = new Promise<never>((_resolve, reject) => {
      interrupt = () => reject(new Error('Checkpoint wait interrupted.'));
      signal.addEventListener('abort', interrupt, { once: true });
    });
    while (true) {
      // Racing the reader also bounds custom transports which ignore AbortSignal.
      const state = await Promise.race([indexer.getStateDetails(signal), cancelled]);
      // Synchronous adapters can prevent the timeout callback from running.
      if (performance.now() - startedAt >= timeoutMs) controller.abort();
      if (signal.aborted) signal.throwIfAborted();
      if (state !== null) {
        // nowMs anchors the caller's clock at invocation; freshness ages while
        // polling even when the system wall clock changes during the wait.
        const healthOptions = options.nowMs === undefined ? options
          : { ...options, nowMs: options.nowMs + Math.floor(performance.now() - startedAt) };
        const health = assertIndexerHealthy(state, healthOptions);
        lastBlock = health.indexedBlock;
        if (lastBlock >= targetBlock) return state;
      }
      await Promise.race([new Promise<void>(resolve => { pollTimer = setTimeout(resolve, pollIntervalMs); }), cancelled]);
      pollTimer = undefined;
      signal.throwIfAborted();
    }
  } catch (cause) {
    if (options.signal?.aborted) throw new DaoShipsError('ABORTED', 'Indexer checkpoint wait cancelled.');
    if (controller.signal.aborted) throw new DaoShipsError('TIMEOUT', 'Indexer did not reach the requested block before the deadline.', { targetBlock: targetBlock.toString(), lastIndexedBlock: lastBlock?.toString() ?? null, timeoutMs });
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('INDEXER_ERROR', 'Unable to read indexer checkpoint.', {}, { cause });
  } finally {
    clearTimeout(timeout);
    if (pollTimer !== undefined) clearTimeout(pollTimer);
    if (interrupt) signal.removeEventListener('abort', interrupt);
    controller.abort();
  }
}
