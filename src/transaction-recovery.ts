import { getZoneForAddress, toShard, type Shard, type TransactionResponse } from 'quais';
import type { PreparedTransaction } from './chain.js';
import { DaoShipsError } from './errors.js';
import { sendPreparedTransaction, type TransactionSigner, type WaitableTransaction } from './transactions.js';
import { address, hex, uint, type Hex } from './values.js';

export type RecoveryStatus = 'prepared' | 'broadcasting' | 'submitted' | 'mined' | 'reverted' | 'replaced' | 'cancelled' | 'not_sent' | 'unknown';
export interface RecoveryIntent {
  readonly chainId: number; readonly from: Hex; readonly to: Hex; readonly data: Hex; readonly value: bigint; readonly operation: string; readonly nonce: number;
}
export interface RecoveryReceipt {
  hash: Hex; blockHash: Hex; blockNumber: number; status: 0 | 1; confirmations: number;
}
export interface RecoveryReplacement {
  hash: Hex;
  /** cancellation_shape is a successful zero-value empty self-transfer, not proof of user intent. */
  reason: 'repriced' | 'different_payload' | 'cancellation_shape';
}
export interface RecoveryTransactionRecord {
  version: 1; kind: 'transaction'; id: string; revision: number; intent: RecoveryIntent; status: RecoveryStatus;
  hash?: Hex; replacement?: RecoveryReplacement; receipt?: RecoveryReceipt;
}
export interface RecoveryNonceRecord {
  version: 1; kind: 'nonce'; id: string; revision: number; chainId: number; from: Hex;
  nextNonce: number; blockedBy: string | null;
}
export type RecoveryRecord = RecoveryTransactionRecord | RecoveryNonceRecord;

/**
 * CAS must atomically test revision and durably write the whole detached record.
 * null means insert only if absent. A successful write uses revision (old + 1),
 * starting at zero. Revisions never reset; kind, ID and transaction intent are
 * immutable after insert (account chain/sender are immutable too). Adapters must
 * reject changes to these identity fields. Durable adapters must provide these
 * guarantees across every process sharing an account; read/write alone is unsafe.
 */
export interface TransactionRecoveryStore {
  read(key: string): Promise<RecoveryRecord | null>;
  compareAndSwap(key: string, expectedRevision: number | null, next: RecoveryRecord): Promise<boolean>;
}
export interface RecoveryCoordinationOptions { waitTimeoutMs?: number; signal?: AbortSignal }
export interface RecoveryCoordinator {
  runExclusive<T>(scope: string, work: () => Promise<T>, options?: RecoveryCoordinationOptions): Promise<T>;
}
export interface RecoveryProvider {
  getNetwork(): Promise<{ chainId: bigint }>;
  getTransactionCount(account: string, blockTag?: 'pending' | 'latest'): Promise<number>;
  getTransaction(hash: string): Promise<unknown>;
  getTransactionReceipt(hash: string): Promise<unknown>;
  getBlock(shard: Shard, tag: number | 'latest'): Promise<unknown>;
}
const MAX_RECORD_CHARACTERS = 2_200_000;
const STATUSES: readonly string[] = ['prepared', 'broadcasting', 'submitted', 'mined', 'reverted', 'replaced', 'cancelled', 'not_sent', 'unknown'];
function invalid(message: string): never { throw new DaoShipsError('INVALID_ARGUMENT', message); }
function integer(value: unknown, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value >= Number.MAX_SAFE_INTEGER) invalid('Expected a bounded safe integer.');
  return value;
}
function recordId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value)) invalid('Recovery ID must contain 1–200 safe identifier characters.');
  return value;
}
function hash(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value)) invalid('Expected a 32-byte transaction or block hash.');
  return value.toLowerCase() as Hex;
}
function plain(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Recovery records must be plain data objects.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (typeof key !== 'string' || !allowed.includes(key) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('Recovery record contains an unsupported field or accessor.');
  }
  return value as Record<string, unknown>;
}
function normalizeRecord(input: unknown, json = false): RecoveryRecord {
  const p = plain(input, ['version', 'kind', 'id', 'revision', 'intent', 'status', 'hash', 'replacement', 'receipt', 'chainId', 'from', 'nextNonce', 'blockedBy']);
  if (p.version !== 1) invalid('Unsupported recovery record version.');
  const base = { version: 1 as const, id: recordId(p.id), revision: integer(p.revision) };
  if (p.kind === 'nonce') {
    plain(p, ['version', 'kind', 'id', 'revision', 'chainId', 'from', 'nextNonce', 'blockedBy']);
    return { ...base, kind: 'nonce', chainId: integer(p.chainId, 1), from: address(p.from as string), nextNonce: integer(p.nextNonce),
      blockedBy: p.blockedBy === null ? null : recordId(p.blockedBy) };
  }
  if (p.kind !== 'transaction') invalid('Unknown recovery record kind.');
  plain(p, ['version', 'kind', 'id', 'revision', 'intent', 'status', 'hash', 'replacement', 'receipt']);
  const i = plain(p.intent, ['chainId', 'from', 'to', 'data', 'value', 'operation', 'nonce']);
  if (typeof i.operation !== 'string' || !i.operation || i.operation.length > 128) invalid('Recovery operation must contain 1–128 characters.');
  if (typeof i.data !== 'string' || i.data.length > 2_097_154) invalid('Recovery calldata exceeds 1 MiB.');
  if (json && (typeof i.value !== 'string' || !/^(0|[1-9][0-9]{0,77})$/.test(i.value))) invalid('Serialized transaction value must be a canonical decimal string.');
  const intent = { chainId: integer(i.chainId, 1), from: address(i.from as string), to: address(i.to as string),
    data: hex(i.data), value: uint(json ? BigInt(i.value as string) : i.value as bigint), operation: i.operation, nonce: integer(i.nonce) };
  if (typeof p.status !== 'string' || !STATUSES.includes(p.status)) invalid('Unknown recovery transaction status.');
  const result: RecoveryTransactionRecord = { ...base, kind: 'transaction', intent, status: p.status as RecoveryStatus };
  if (p.hash !== undefined) result.hash = hash(p.hash);
  if (p.replacement !== undefined) {
    const r = plain(p.replacement, ['hash', 'reason']);
    if (!['repriced', 'different_payload', 'cancellation_shape'].includes(r.reason as string)) invalid('Unknown replacement reason.');
    result.replacement = { hash: hash(r.hash), reason: r.reason as RecoveryReplacement['reason'] };
  }
  if (p.receipt !== undefined) {
    const r = plain(p.receipt, ['hash', 'blockHash', 'blockNumber', 'status', 'confirmations']);
    if (r.status !== 0 && r.status !== 1) invalid('Recovery receipts require a known numeric status.');
    result.receipt = { hash: hash(r.hash), blockHash: hash(r.blockHash), blockNumber: integer(r.blockNumber), status: r.status, confirmations: integer(r.confirmations, 1) };
  }
  if (['submitted', 'mined', 'reverted'].includes(result.status) && !result.hash) invalid('Submitted records require a transaction hash.');
  if (['mined', 'reverted', 'replaced', 'cancelled'].includes(result.status) && !result.receipt) invalid('Final observations require a receipt.');
  if (['replaced', 'cancelled'].includes(result.status) && !result.replacement) invalid('Replacement observations require evidence.');
  if (['prepared', 'broadcasting', 'not_sent'].includes(result.status) && (result.hash || result.replacement || result.receipt)) invalid('Unsubmitted records cannot contain transaction evidence.');
  if (['submitted', 'unknown'].includes(result.status) && result.receipt) invalid('Pending or unknown records cannot claim a final receipt.');
  if (result.status === 'mined' && (result.receipt?.status !== 1 || result.receipt.hash !== result.hash)) invalid('Mined status requires the original successful receipt.');
  if (result.status === 'reverted' && (result.receipt?.status !== 0 || result.receipt.hash !== result.hash)) invalid('Reverted status requires the original reverted receipt.');
  if (['replaced', 'cancelled'].includes(result.status) && (result.receipt?.hash !== result.replacement?.hash || result.replacement?.hash === result.hash)) invalid('Replacement receipt must identify a different transaction.');
  if (result.status === 'cancelled' && (result.receipt?.status !== 1 || result.replacement?.reason !== 'cancellation_shape')) invalid('Cancellation requires a successful cancellation-shaped replacement.');
  if (result.receipt && result.receipt.hash !== result.hash && result.receipt.hash !== result.replacement?.hash) invalid('Receipt hash does not belong to this record.');
  return result;
}
/** Versioned JSON: uint256 transaction value is stored as decimal text, never a JS number. */
export function serializeRecoveryRecord(record: RecoveryRecord): string {
  try {
    const normalized = normalizeRecord(record);
    return JSON.stringify(normalized, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid recovery record.', {}, { cause });
  }
}
export function parseRecoveryRecord(serialized: string): RecoveryRecord {
  if (typeof serialized !== 'string' || serialized.length > MAX_RECORD_CHARACTERS) invalid('Recovery JSON exceeds its size bound.');
  try { return normalizeRecord(JSON.parse(serialized), true); }
  catch (cause) { if (cause instanceof DaoShipsError) throw cause; throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid recovery JSON.', {}, { cause }); }
}
function copy<T extends RecoveryRecord>(record: T): T { return parseRecoveryRecord(serializeRecoveryRecord(record)) as T; }

/** Reference CAS store for tests/single-process use. It is not durable across restarts. */
export class InMemoryTransactionRecoveryStore implements TransactionRecoveryStore {
  private readonly records = new Map<string, string>();
  async read(key: string): Promise<RecoveryRecord | null> { const value = this.records.get(key); return value === undefined ? null : parseRecoveryRecord(value); }
  async compareAndSwap(key: string, expectedRevision: number | null, next: RecoveryRecord): Promise<boolean> {
    const normalizedNext = normalizeRecord(next);
    const serialized = serializeRecoveryRecord(normalizedNext);
    const current = this.records.get(key);
    const previous = current === undefined ? null : parseRecoveryRecord(current);
    if ((previous?.revision ?? null) !== expectedRevision) return false;
    if (previous && (previous.kind !== next.kind || previous.id !== next.id)) invalid('Recovery record identity is immutable.');
    if (previous?.kind === 'transaction' && next.kind === 'transaction') {
      const intentJson = (intent: RecoveryIntent) => JSON.stringify(intent, (_key, value: unknown) => typeof value === 'bigint' ? value.toString() : value);
      if (intentJson(previous.intent) !== intentJson((normalizedNext as RecoveryTransactionRecord).intent)) invalid('Recorded transaction intent is immutable.');
    }
    if (previous?.kind === 'nonce' && next.kind === 'nonce' && (previous.chainId !== next.chainId || previous.from !== next.from)) invalid('Account nonce identity is immutable.');
    if (next.revision !== (expectedRevision === null ? 0 : expectedRevision + 1)) invalid('CAS must increment the record revision exactly once.');
    this.records.set(key, serialized); return true;
  }
}

/** Bounded FIFO coordination within one process. Work is never unlocked merely because it runs slowly. */
export class InProcessRecoveryCoordinator implements RecoveryCoordinator {
  private readonly scopes = new Map<string, { active: boolean; queue: (() => void)[] }>();
  constructor(private readonly maxQueuedPerAccount = 100, private readonly maxAccounts = 1000) {
    integer(maxQueuedPerAccount, 1); integer(maxAccounts, 1);
  }
  runExclusive<T>(scope: string, work: () => Promise<T>, options: RecoveryCoordinationOptions = {}): Promise<T> {
    const waitTimeoutMs = options.waitTimeoutMs ?? 30_000, signal = options.signal;
    if (!Number.isSafeInteger(waitTimeoutMs) || waitTimeoutMs < 1 || waitTimeoutMs > 2_147_483_647) invalid('Invalid coordinator wait timeout.');
    let entry = this.scopes.get(scope);
    if (!entry) {
      if (this.scopes.size >= this.maxAccounts) return Promise.reject(new DaoShipsError('RECOVERY_BLOCKED', 'Coordinator account capacity reached.'));
      entry = { active: false, queue: [] }; this.scopes.set(scope, entry);
    }
    const state = entry;
    if (state.queue.length >= this.maxQueuedPerAccount) return Promise.reject(new DaoShipsError('RECOVERY_BLOCKED', 'Coordinator queue capacity reached.'));
    return new Promise<T>((resolve, reject) => {
      let started = false, stopped = false;
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      const cancel = () => {
        if (started || stopped) return;
        stopped = true; cleanup();
        const index = state.queue.indexOf(start); if (index >= 0) state.queue.splice(index, 1);
        if (!state.active && !state.queue.length) this.scopes.delete(scope);
        reject(new DaoShipsError('RECOVERY_BLOCKED', 'Stopped waiting for account coordination; no work started.'));
      };
      const abort = cancel;
      const timer = setTimeout(cancel, waitTimeoutMs);
      const start = () => {
        if (stopped) return;
        started = true; cleanup(); state.active = true;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          state.active = false;
          const next = state.queue.shift(); if (next) next(); else this.scopes.delete(scope);
        });
      };
      if (signal?.aborted) { cancel(); return; }
      signal?.addEventListener('abort', abort, { once: true });
      if (state.active) state.queue.push(start); else start();
    });
  }
}
const defaultCoordinator = new InProcessRecoveryCoordinator();
export function recoveryTransactionKey(id: string): string { return `transaction:${recordId(id)}`; }
export function recoveryAccountKey(chainId: number, from: string): string { return `account:${integer(chainId, 1)}:${address(from).toLowerCase()}`; }
async function readRecord(store: TransactionRecoveryStore, key: string): Promise<RecoveryRecord | null> {
  try { const record = await store.read(key); return record === null ? null : copy(record); }
  catch (cause) { if (cause instanceof DaoShipsError) throw cause; throw new DaoShipsError('PERSISTENCE_ERROR', 'Recovery store read failed.', { key }, { cause }); }
}
async function compareRecord(store: TransactionRecoveryStore, key: string, expected: number | null, next: RecoveryRecord): Promise<boolean> {
  try {
    const result = await store.compareAndSwap(key, expected, copy(next));
    if (typeof result !== 'boolean') throw new DaoShipsError('INVALID_RESPONSE', 'Recovery CAS must return a boolean.');
    return result;
  } catch (cause) {
    if (cause instanceof DaoShipsError) throw cause;
    throw new DaoShipsError('PERSISTENCE_ERROR', 'Recovery store write outcome is unknown.', { key }, { cause });
  }
}
async function transactionRecord(store: TransactionRecoveryStore, id: string): Promise<RecoveryTransactionRecord> {
  const record = await readRecord(store, recoveryTransactionKey(id));
  if (!record || record.kind !== 'transaction' || record.id !== id) throw new DaoShipsError('RECOVERY_CONFLICT', 'Recovery transaction does not exist or has the wrong identity.', { id });
  return record;
}
async function writeTransaction(store: TransactionRecoveryStore, previous: RecoveryTransactionRecord, update: Partial<Pick<RecoveryTransactionRecord, 'status' | 'hash' | 'replacement' | 'receipt'>>): Promise<RecoveryTransactionRecord> {
  const next = copy({ ...previous, ...update, revision: previous.revision + 1 });
  if (!await compareRecord(store, recoveryTransactionKey(previous.id), previous.revision, next)) throw new DaoShipsError('RECOVERY_CONFLICT', 'Recovery record changed concurrently.', { id: previous.id });
  return next;
}
async function releaseAccount(store: TransactionRecoveryStore, record: RecoveryTransactionRecord, sent: boolean): Promise<void> {
  const key = recoveryAccountKey(record.intent.chainId, record.intent.from);
  for (let attempt = 0; attempt < 8; attempt++) {
    const current = await readRecord(store, key);
    if (!current) return;
    if (current.kind !== 'nonce' || current.id !== key || current.chainId !== record.intent.chainId || current.from !== record.intent.from) throw new DaoShipsError('RECOVERY_CONFLICT', 'Invalid account nonce cursor.');
    if (current.blockedBy !== record.id) return;
    const next = { ...current, revision: current.revision + 1, blockedBy: null,
      nextNonce: sent ? Math.max(current.nextNonce, record.intent.nonce + 1) : current.nextNonce === record.intent.nonce + 1 ? record.intent.nonce : current.nextNonce };
    if (await compareRecord(store, key, current.revision, next)) return;
  }
  throw new DaoShipsError('RECOVERY_CONFLICT', 'Could not release the account reservation.', { id: record.id });
}
function timeoutValue(value: number | undefined): number {
  const result = value ?? 30_000;
  if (!Number.isSafeInteger(result) || result < 1 || result > 2_147_483_647) invalid('Invalid recovery RPC timeout.');
  return result;
}
function bounded<T>(call: () => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let stopped = false;
    const finish = (error?: unknown, value?: T) => {
      if (stopped) return;
      stopped = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error !== undefined) reject(error); else resolve(value!);
    };
    const abort = () => finish(new DaoShipsError('ABORTED', 'Recovery preflight was cancelled; no broadcast started.'));
    const timer = setTimeout(() => finish(new DaoShipsError('TIMEOUT', 'Recovery RPC wait timed out.')), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => stopped ? undefined : call()).then(value => finish(undefined, value),
      cause => finish(cause === undefined ? new DaoShipsError('CHAIN_ERROR', 'Recovery RPC failed without an error.') : cause));
  });
}
export interface RecoverySendOptions extends RecoveryCoordinationOptions {
  id: string; store: TransactionRecoveryStore; coordinator?: RecoveryCoordinator;
  refresh: () => Promise<PreparedTransaction>; gasMultiplierPercent?: bigint; timeoutMs?: number;
}
/** One-shot send with a durable pre-broadcast marker and nonce quarantine on ambiguous outcomes. */
export async function sendRecoverableTransaction(prepared: PreparedTransaction,
  signer: TransactionSigner & { provider: (Pick<RecoveryProvider, 'getNetwork' | 'getTransactionCount'>) | null }, options: RecoverySendOptions,
): Promise<{ record: RecoveryTransactionRecord; transaction: TransactionResponse }> {
  const { store, refresh, gasMultiplierPercent, signal, waitTimeoutMs } = options;
  const id = recordId(options.id), timeoutMs = timeoutValue(options.timeoutMs), coordinator = options.coordinator ?? defaultCoordinator;
  const original = { ...prepared, from: address(prepared.from), to: address(prepared.to), data: hex(prepared.data), value: uint(prepared.value), checkedAt: { ...prepared.checkedAt } };
  const provider = signer.provider;
  if (!provider) throw new DaoShipsError('CHAIN_ERROR', 'Recovery signing requires a connected provider.');
  if (typeof refresh !== 'function') invalid('Recovery send requires a refresh callback.');
  const accountKey = recoveryAccountKey(original.chainId, original.from);
  return coordinator.runExclusive(accountKey, async () => {
    if (await readRecord(store, recoveryTransactionKey(id))) throw new DaoShipsError('RECOVERY_CONFLICT', 'This intent ID is already recorded; inspect it instead of resending.', { id });
    const preflight = <T>(call: () => Promise<T>) => bounded(call, timeoutMs, signal);
    const [network, from, pending] = await Promise.all([preflight(() => provider.getNetwork()), preflight(() => signer.getAddress()), preflight(() => provider.getTransactionCount(original.from, 'pending'))]);
    if (signer.provider !== provider || network.chainId !== BigInt(original.chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Recovery signer network changed.');
    if (address(from) !== original.from) throw new DaoShipsError('SIGNER_MISMATCH', 'Recovery signer does not match intent.');
    const cursor = await readRecord(store, accountKey);
    if (cursor && (cursor.kind !== 'nonce' || cursor.chainId !== original.chainId || cursor.from !== original.from || cursor.id !== accountKey)) throw new DaoShipsError('RECOVERY_CONFLICT', 'Invalid account nonce cursor.');
    if (cursor?.blockedBy) throw new DaoShipsError('RECOVERY_BLOCKED', 'Account has an unresolved broadcast reservation.', { id: cursor.blockedBy, account: original.from });
    const nonce = integer(Math.max(integer(pending), cursor?.nextNonce ?? 0));
    integer(nonce + 1);
    let record = copy<RecoveryTransactionRecord>({ version: 1, kind: 'transaction', id, revision: 0, status: 'prepared', intent: {
      chainId: original.chainId, from: original.from, to: original.to, data: original.data, value: original.value, operation: original.operation, nonce,
    } });
    if (!await compareRecord(store, recoveryTransactionKey(id), null, record)) throw new DaoShipsError('RECOVERY_CONFLICT', 'Intent was created concurrently.', { id });
    const reservation: RecoveryNonceRecord = { version: 1, kind: 'nonce', id: accountKey, revision: cursor ? cursor.revision + 1 : 0,
      chainId: original.chainId, from: original.from, nextNonce: nonce + 1, blockedBy: id };
    if (!await compareRecord(store, accountKey, cursor?.revision ?? null, reservation)) {
      await writeTransaction(store, record, { status: 'not_sent' });
      throw new DaoShipsError('RECOVERY_CONFLICT', 'Account was reserved concurrently; no transaction was sent.', { id });
    }
    let attempted = false;
    const guardedProvider = { getNetwork: () => preflight(() => provider.getNetwork()) };
    const guardedSigner: TransactionSigner = {
      get provider() {
        if (signer.provider !== provider) throw new DaoShipsError('CHAIN_MISMATCH', 'Recovery signer provider changed before broadcast.');
        return guardedProvider;
      },
      getAddress: () => preflight(() => signer.getAddress()), estimateGas: request => preflight(() => signer.estimateGas(request)),
      async sendTransaction(request) {
        record = await writeTransaction(store, record, { status: 'broadcasting' });
        // Persistence can await an external database after the normal send guard.
        // Recheck the captured wallet identity at the last asynchronous boundary.
        if (signer.provider !== provider) throw new DaoShipsError('CHAIN_MISMATCH', 'Recovery signer provider changed before broadcast.');
        const [currentNetwork, currentFrom] = await Promise.all([
          preflight(() => provider.getNetwork()), preflight(() => signer.getAddress()),
        ]);
        if (signer.provider !== provider || currentNetwork.chainId !== BigInt(original.chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Recovery signer network changed before broadcast.');
        if (address(currentFrom) !== original.from) throw new DaoShipsError('SIGNER_MISMATCH', 'Recovery signer account changed before broadcast.');
        if (signal?.aborted) throw new DaoShipsError('ABORTED', 'Recovery preflight was cancelled; no broadcast started.');
        attempted = true;
        return signer.sendTransaction(request);
      },
    };
    try {
      const transaction = await sendPreparedTransaction(original, guardedSigner, {
        refresh: () => preflight(refresh), nonce, ...(gasMultiplierPercent === undefined ? {} : { gasMultiplierPercent }),
        async onSubmitted(submitted) { record = await writeTransaction(store, record, { status: 'submitted', hash: hash(submitted.hash) }); },
      });
      await releaseAccount(store, record, true);
      return { record: copy(record), transaction };
    } catch (cause) {
      if (!attempted) {
        try {
          // Abandonment can win between intent insertion and account reservation.
          // Its durable not_sent state authorizes releasing that later reservation.
          const current = await transactionRecord(store, id);
          record = current.status === 'not_sent' ? current : await writeTransaction(store, record, { status: 'not_sent' });
          await releaseAccount(store, record, false);
        }
        catch { /* Leave the durable reservation quarantined if cleanup is uncertain. */ }
        if (cause instanceof DaoShipsError && cause.code === 'BROADCAST_ERROR' && cause.cause instanceof DaoShipsError) throw cause.cause;
        throw cause;
      }
      const returnedHash = cause instanceof DaoShipsError && typeof cause.details.hash === 'string' ? hash(cause.details.hash) : record.hash;
      try {
        const latest = await transactionRecord(store, id);
        if (!['submitted', 'mined', 'reverted', 'replaced', 'cancelled'].includes(latest.status)) {
          record = await writeTransaction(store, latest, { status: 'unknown', ...(returnedHash ? { hash: returnedHash } : {}) });
        }
      } catch { /* The broadcasting marker remains the restart-safe uncertainty boundary. */ }
      throw new DaoShipsError(returnedHash ? 'PERSISTENCE_ERROR' : 'BROADCAST_ERROR', 'Transaction may have been broadcast; recover this intent before any new send.',
        { id, chainId: original.chainId, from: original.from, nonce, ...(returnedHash ? { hash: returnedHash } : {}) }, { cause });
    }
  }, { ...(signal ? { signal } : {}), ...(waitTimeoutMs === undefined ? {} : { waitTimeoutMs }) });
}

export interface RecoveryInspectionOptions { transactionHash?: string; replacementHash?: string; confirmations?: number; timeoutMs?: number }
export interface RecoveryInspection {
  outcome: 'not_sent' | 'pending' | 'mined' | 'reverted' | 'replaced' | 'cancelled' | 'unknown';
  record: RecoveryTransactionRecord;
  reason: string;
}
function observedTransaction(raw: unknown, expectedHash: Hex, intent: RecoveryIntent): { hash: Hex; to: Hex | null; data: Hex; value: bigint } | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw new DaoShipsError('INVALID_RESPONSE', 'Malformed recovery transaction.');
  const tx = raw as Record<string, unknown>;
  if (hash(tx.hash) !== expectedHash || address(tx.from as string) !== intent.from || tx.chainId !== BigInt(intent.chainId) || tx.nonce !== intent.nonce) {
    throw new DaoShipsError('CHAIN_MISMATCH', 'Observed transaction does not match the expected hash, sender, chain and nonce.');
  }
  if (typeof tx.data !== 'string' || tx.data.length > 2_097_154) throw new DaoShipsError('INVALID_RESPONSE', 'Observed calldata exceeds its bound.');
  return { hash: expectedHash, to: tx.to === null ? null : address(tx.to as string), data: hex(tx.data), value: uint(tx.value as bigint) };
}
function sameIntent(tx: NonNullable<ReturnType<typeof observedTransaction>>, intent: RecoveryIntent): boolean {
  return tx.to === intent.to && tx.data.toLowerCase() === intent.data.toLowerCase() && tx.value === intent.value;
}
/** Read only from the network, then persist verified observations. Never signs or resubmits. */
export async function inspectRecoveryTransaction(store: TransactionRecoveryStore, provider: RecoveryProvider, id: string,
  options: RecoveryInspectionOptions = {}): Promise<RecoveryInspection> {
  id = recordId(id);
  const timeoutMs = timeoutValue(options.timeoutMs), confirmations = integer(options.confirmations ?? 1, 1);
  const providedHash = options.transactionHash === undefined ? undefined : hash(options.transactionHash);
  const replacementHash = options.replacementHash === undefined ? undefined : hash(options.replacementHash);
  let record = await transactionRecord(store, id);
  const intent = { ...record.intent };
  const checkNetwork = async () => {
    const network = await bounded(() => provider.getNetwork(), timeoutMs);
    if (network.chainId !== BigInt(intent.chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Recovery provider is connected to another chain.');
  };
  await checkNetwork();
  if (!providedHash && !replacementHash && (record.status === 'prepared' || record.status === 'not_sent')) {
    if (record.status === 'not_sent') await releaseAccount(store, record, false);
    return { outcome: 'not_sent', record: copy(record), reason: record.status === 'prepared' ? 'Intent is prepared; explicitly abandon it before attempting a different send.' : 'This intent never entered its broadcast call.' };
  }
  if (providedHash && record.hash && providedHash !== record.hash) throw new DaoShipsError('RECOVERY_CONFLICT', 'Use replacementHash for a different broadcast hash.');
  const originalHash = record.hash ?? providedHash;
  const candidateHash = replacementHash ?? record.replacement?.hash;
  const zone = getZoneForAddress(intent.from);
  if (!zone) throw new DaoShipsError('INVALID_ARGUMENT', 'Sender has no supported Quai zone.');
  const observe = async (txHash: Hex) => {
    const [rawTx, rawReceipt] = await Promise.all([bounded(() => provider.getTransaction(txHash), timeoutMs), bounded(() => provider.getTransactionReceipt(txHash), timeoutMs)]);
    const tx = observedTransaction(rawTx, txHash, intent);
    if (!tx || rawReceipt === null) return { tx, receipt: undefined };
    if (!rawReceipt || typeof rawReceipt !== 'object') throw new DaoShipsError('INVALID_RESPONSE', 'Malformed recovery receipt.');
    const receipt = rawReceipt as Record<string, unknown>;
    if (hash(receipt.hash) !== txHash || address(receipt.from as string) !== intent.from || (receipt.to === null ? null : address(receipt.to as string)) !== tx.to) throw new DaoShipsError('CHAIN_MISMATCH', 'Receipt does not belong to the observed transaction.');
    const status = receipt.status;
    if (status !== 0 && status !== 1) return { tx, receipt: undefined };
    const blockNumber = integer(receipt.blockNumber), blockHash = hash(receipt.blockHash);
    const [canonicalRaw, headRaw] = await Promise.all([bounded(() => provider.getBlock(toShard(zone), blockNumber), timeoutMs), bounded(() => provider.getBlock(toShard(zone), 'latest'), timeoutMs)]);
    const canonical = canonicalRaw as { hash?: string; woHeader?: { number?: number } } | null;
    const head = headRaw as { woHeader?: { number?: number } } | null;
    if (!canonical || (typeof canonical.hash !== 'string' || canonical.hash.toLowerCase() !== blockHash) || canonical.woHeader?.number !== blockNumber) return { tx, receipt: undefined };
    const observedConfirmations = integer(head?.woHeader?.number) - blockNumber + 1;
    if (observedConfirmations < confirmations) return { tx, receipt: undefined };
    return { tx, receipt: { hash: txHash, blockHash, blockNumber, status, confirmations: observedConfirmations } as RecoveryReceipt };
  };
  let outcome: RecoveryInspection['outcome'] = 'unknown', reason = 'No verified transaction evidence; do not resubmit.';
  const update: Partial<Pick<RecoveryTransactionRecord, 'status' | 'hash' | 'replacement' | 'receipt'>> = {};
  let observed = false;
  if (originalHash) {
    const original = await observe(originalHash);
    if (original.tx && !sameIntent(original.tx, intent)) throw new DaoShipsError('PLAN_CHANGED', 'Original hash contains a different transaction intent.');
    if (original.tx) {
      observed = true; update.hash = originalHash;
      if (original.receipt) { update.receipt = original.receipt; outcome = original.receipt.status === 1 ? 'mined' : 'reverted'; reason = 'Original transaction has a canonical receipt at the requested depth.'; }
      else { outcome = 'pending'; reason = 'Original transaction is known but has no confirmed canonical receipt.'; }
    }
  }
  if (!['mined', 'reverted'].includes(outcome) && candidateHash && candidateHash !== originalHash) {
    const replacement = await observe(candidateHash);
    if (replacement.tx) {
      observed = true;
      const cancellationShape = !sameIntent(replacement.tx, intent) && replacement.tx.to === intent.from && replacement.tx.value === 0n && replacement.tx.data === '0x';
      update.replacement = { hash: candidateHash, reason: sameIntent(replacement.tx, intent) ? 'repriced' : cancellationShape ? 'cancellation_shape' : 'different_payload' };
      if (replacement.receipt) {
        update.receipt = replacement.receipt; outcome = cancellationShape && replacement.receipt.status === 1 ? 'cancelled' : 'replaced';
        reason = outcome === 'cancelled' ? 'A canonical successful zero-value empty self-transfer consumed this nonce; cancellation is a shape heuristic.' : 'A different canonical transaction consumed this sender nonce; inspect replacement reason and receipt status.';
      } else { outcome = 'pending'; reason = 'Replacement candidate is pending; the original may still win.'; }
    }
  }
  if (!observed && !originalHash && !candidateHash) {
    const latestNonce = integer(await bounded(() => provider.getTransactionCount(intent.from, 'latest'), timeoutMs));
    reason = latestNonce > intent.nonce ? 'Sender nonce has been consumed; supply a transaction or replacement hash to identify its outcome.' : 'Nonce has not advanced, which does not prove no broadcast occurred; keep this intent quarantined.';
  }
  if (!observed && record.status === 'not_sent') { outcome = 'not_sent'; reason = 'The durable record says this sender never entered its broadcast call.'; }
  await checkNetwork();
  // Clear stale receipt observations after a reorg; they are observations, not permanent finality.
  const next = { ...record, ...update, status: outcome === 'pending' ? (update.hash ?? record.hash ? 'submitted' : 'unknown') : outcome,
    revision: record.revision + 1 } as RecoveryTransactionRecord;
  if (!update.receipt) delete next.receipt;
  if (!await compareRecord(store, recoveryTransactionKey(id), record.revision, next)) throw new DaoShipsError('RECOVERY_CONFLICT', 'Recovery observation raced another update.', { id });
  record = next;
  if (observed) await releaseAccount(store, record, true);
  return { outcome, record: copy(record), reason };
}

/** Explicitly abandon a still-prepared intent. The CAS prevents a concurrent broadcaster from using it. */
export async function abandonPreparedTransaction(store: TransactionRecoveryStore, id: string): Promise<RecoveryTransactionRecord> {
  const record = await transactionRecord(store, recordId(id));
  if (record.status !== 'prepared' && record.status !== 'not_sent') throw new DaoShipsError('RECOVERY_BLOCKED', 'A broadcast may have started; inspect network evidence instead.', { id });
  const next = record.status === 'not_sent' ? record : await writeTransaction(store, record, { status: 'not_sent' });
  await releaseAccount(store, next, false); return copy(next);
}

/** Wait on the caller's native transaction so quais TRANSACTION_REPLACED evidence is retained, then verify it via RPC. */
export async function waitForRecoveryTransaction(store: TransactionRecoveryStore, provider: RecoveryProvider, id: string,
  transaction: WaitableTransaction, options: Omit<RecoveryInspectionOptions, 'transactionHash' | 'replacementHash'> = {}): Promise<RecoveryInspection> {
  const wait = transaction.wait.bind(transaction);
  const txHash = hash(transaction.hash), confirmations = integer(options.confirmations ?? 1, 1), timeoutMs = timeoutValue(options.timeoutMs);
  const record = await transactionRecord(store, recordId(id));
  if (record.hash && record.hash !== txHash) throw new DaoShipsError('RECOVERY_CONFLICT', 'Waitable transaction hash differs from the recorded hash.');
  let replacementHash: Hex | undefined;
  try { await bounded(() => wait(confirmations, timeoutMs), timeoutMs); }
  catch (cause) {
    if (cause && typeof cause === 'object' && (cause as { code?: unknown }).code === 'TRANSACTION_REPLACED') {
      const candidate = (cause as { replacement?: { hash?: unknown } }).replacement?.hash;
      if (candidate !== undefined) replacementHash = hash(candidate);
    }
    // Timeouts, wait failures and replaced receipts are all re-read through validated RPC evidence.
  }
  return inspectRecoveryTransaction(store, provider, id, { transactionHash: txHash, ...(replacementHash ? { replacementHash } : {}), confirmations, timeoutMs });
}

export interface RecoveryScanOptions {
  fromBlock: number; toBlock: number;
  /** Caller-selected finite window; defaults cap scans at 128 blocks and 1,000 transactions. */
  maxBlocks?: number; maxTransactions?: number; timeoutMs?: number;
  /** Exclude the already-known original hash from the returned candidates. */
  originalHash?: string;
}
export interface RecoveryScanResult {
  candidates: { hash: Hex; blockNumber: number; blockHash: Hex; samePayload: boolean }[];
  scannedBlocks: number; scannedTransactions: number;
  /** Completeness applies only to this exact block window, never the mempool or entire account history. */
  complete: boolean;
}
/** Find same-sender/same-nonce candidates after restart, only in an explicit bounded canonical block window. */
export async function scanRecoveryReplacements(provider: RecoveryProvider, intentInput: RecoveryIntent, options: RecoveryScanOptions): Promise<RecoveryScanResult> {
  const intent = copy<RecoveryTransactionRecord>({ version: 1, kind: 'transaction', id: 'scan', revision: 0, status: 'prepared', intent: intentInput }).intent;
  const fromBlock = integer(options.fromBlock), toBlock = integer(options.toBlock);
  const maxBlocks = integer(options.maxBlocks ?? 128, 1), maxTransactions = integer(options.maxTransactions ?? 1000, 1), timeoutMs = timeoutValue(options.timeoutMs);
  const originalHash = options.originalHash === undefined ? undefined : hash(options.originalHash);
  if (maxBlocks > 10_000 || maxTransactions > 100_000 || toBlock < fromBlock || toBlock - fromBlock + 1 > maxBlocks) invalid('Recovery scan exceeds its explicit block/transaction bounds.');
  const zone = getZoneForAddress(intent.from);
  if (!zone) invalid('Recovery sender has no Quai zone.');
  const checkNetwork = async () => {
    const network = await bounded(() => provider.getNetwork(), timeoutMs);
    if (network.chainId !== BigInt(intent.chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Replacement scan provider is on another chain.');
  };
  await checkNetwork();
  const result: RecoveryScanResult = { candidates: [], scannedBlocks: 0, scannedTransactions: 0, complete: true };
  const scanned: { number: number; hash: Hex }[] = [];
  for (let number = fromBlock; number <= toBlock; number++) {
    const raw = await bounded(() => provider.getBlock(toShard(zone), number), timeoutMs);
    const block = raw as { hash?: unknown; woHeader?: { number?: unknown }; transactions?: unknown } | null;
    if (!block || block.woHeader?.number !== number || !Array.isArray(block.transactions)) { result.complete = false; continue; }
    const blockHash = hash(block.hash);
    result.scannedBlocks++; scanned.push({ number, hash: blockHash });
    for (const entry of block.transactions) {
      if (result.scannedTransactions >= maxTransactions) { result.complete = false; break; }
      result.scannedTransactions++;
      let rawTx: unknown;
      let txHash: Hex;
      if (typeof entry === 'string') {
        txHash = hash(entry);
        rawTx = await bounded(() => provider.getTransaction(txHash), timeoutMs);
      } else if (entry && typeof entry === 'object') {
        rawTx = entry; txHash = hash((entry as { hash?: unknown }).hash);
      } else { result.complete = false; continue; }
      if (!rawTx || typeof rawTx !== 'object') { result.complete = false; continue; }
      const tx = rawTx as Record<string, unknown>;
      if (typeof tx.from !== 'string' || typeof tx.chainId !== 'bigint' || !Number.isSafeInteger(tx.nonce)) { result.complete = false; continue; }
      if (address(tx.from) !== intent.from || tx.nonce !== intent.nonce || tx.chainId !== BigInt(intent.chainId)) continue;
      const candidate = observedTransaction(rawTx, txHash, intent)!;
      if (txHash !== originalHash) result.candidates.push({ hash: txHash, blockNumber: number, blockHash, samePayload: sameIntent(candidate, intent) });
    }
    if (result.scannedTransactions >= maxTransactions && number < toBlock) { result.complete = false; break; }
  }
  // Re-read every scanned height so observed reorgs invalidate affected candidates.
  for (const block of scanned) {
    const canonical = await bounded(() => provider.getBlock(toShard(zone), block.number), timeoutMs) as { hash?: unknown; woHeader?: { number?: unknown } } | null;
    if (!canonical || (typeof canonical.hash !== 'string' || canonical.hash.toLowerCase() !== block.hash) || canonical.woHeader?.number !== block.number) {
      result.complete = false;
      result.candidates = result.candidates.filter(candidate => candidate.blockNumber !== block.number);
    }
  }
  await checkNetwork();
  return result;
}
