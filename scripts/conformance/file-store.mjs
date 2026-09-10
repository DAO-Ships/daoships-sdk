// Reference backend for disposable local conformance/acceptance harnesses only.
// Not a production database: single host/filesystem, one global writer lock,
// bounded whole-file rewrites, and explicit recovery of dead-worker locks.
import { mkdir, open, readFile, rename, rm, stat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseRecoveryRecord, serializeRecoveryRecord, recoveryTransactionKey, recoveryAccountKey } from '../../dist/transaction-recovery.js';

const MAX_BYTES = 32 * 1024 * 1024;
const HASH = /^0x[\da-fA-F]{64}$/;
function invalid(message) { throw Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' }); }
function plain(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid('Expected a plain record.');
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || (fields && !fields.includes(key)) || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) invalid('Unsupported field or accessor.');
  }
  return value;
}
function integer(value, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum || value >= Number.MAX_SAFE_INTEGER) invalid('Invalid revision or block height.');
}
function workflowRecord(value) {
  plain(value, ['version', 'planId', 'revision', 'steps']);
  if (value.version !== 1 || !HASH.test(value.planId)) invalid('Invalid workflow identity.');
  integer(value.revision, 1); plain(value.steps);
  for (const [id, step] of Object.entries(value.steps)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(id)) invalid('Invalid workflow step ID.');
    plain(step, ['status', 'hash', 'checkedAt']);
    if (!['submitting', 'submitted', 'verified'].includes(step.status)) invalid('Invalid workflow status.');
    if (step.hash !== undefined && (typeof step.hash !== 'string' || !HASH.test(step.hash))) invalid('Invalid workflow transaction hash.');
    if (step.checkedAt !== undefined) {
      plain(step.checkedAt, ['blockNumber', 'blockHash']); integer(step.checkedAt.blockNumber);
      if (typeof step.checkedAt.blockHash !== 'string' || !HASH.test(step.checkedAt.blockHash)) invalid('Invalid workflow block hash.');
    }
    if (step.status === 'submitting' && (step.hash || step.checkedAt)) invalid('An unsubmitted step cannot claim execution evidence.');
    if (step.status === 'submitted' && !step.hash) invalid('A submitted step requires a hash.');
    if (step.status === 'verified' && !step.hash && !step.checkedAt) invalid('A verified step requires evidence.');
  }
  const serialized = JSON.stringify(value);
  if (serialized.length > 16_384) invalid('Workflow checkpoint exceeds size limit.');
  return JSON.parse(serialized);
}
async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function lock(directory, timeoutMs) {
  const path = join(directory, '.lock'), token = randomUUID(), deadline = Date.now() + timeoutMs;
  for (;;) {
    try { await mkdir(path, { mode: 0o700 }); break; }
    catch (cause) {
      if (cause.code !== 'EEXIST') throw cause;
      if (Date.now() >= deadline) throw Object.assign(new Error('Store lock remains held; never unlock an uncertain live writer.'), { code: 'RECOVERY_BLOCKED' });
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
  try {
    const owner = await open(join(path, 'owner.json'), 'wx', 0o600);
    try { await owner.writeFile(JSON.stringify({ pid: process.pid, token })); await owner.sync(); } finally { await owner.close(); }
    await syncDirectory(path); await syncDirectory(directory);
  } catch (cause) { await rm(path, { recursive: true, force: true }); throw cause; }
  return { token, async release() {
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
    if (owner.token !== token || owner.pid !== process.pid) throw new Error('Store lock ownership changed.');
    await rm(path, { recursive: true }); await syncDirectory(directory);
  } };
}
/** Never removes a live writer's lock; caller must also have observed this exact worker exit. */
export async function recoverFileStoreLock(directory, exitedPid) {
  if (!Number.isSafeInteger(exitedPid) || exitedPid < 1) invalid('An observed exited process ID is required.');
  const path = join(directory, '.lock');
  const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'));
  if (owner.pid !== exitedPid) throw new Error('Lock owner differs from the exited worker.');
  try { process.kill(exitedPid, 0); throw new Error('Refusing to reclaim a live process lock.'); }
  catch (cause) { if (cause.code !== 'ESRCH') throw cause; }
  // This helper is restricted to an exclusive test/operator recovery session.
  // No other recovery operator may race it; normal writers cannot acquire .lock.
  await rm(path, { recursive: true }); await syncDirectory(directory);
}
async function openStore(directory, kind, options = {}) {
  const timeoutMs = options.lockTimeoutMs ?? 5_000, fault = options.fault;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || (fault !== undefined && typeof fault !== 'function')) invalid('Invalid reference-store options.');
  await mkdir(directory, { recursive: true, mode: 0o700 }); directory = await realpath(directory);
  const filename = join(directory, 'records.json');
  const normalize = kind === 'recovery' ? value => parseRecoveryRecord(serializeRecoveryRecord(value)) : workflowRecord;
  const encode = value => kind === 'recovery' ? serializeRecoveryRecord(value) : JSON.stringify(workflowRecord(value));
  const decode = value => kind === 'recovery' ? parseRecoveryRecord(value) : workflowRecord(JSON.parse(value));
  const identity = (key, value) => {
    if (kind === 'workflow') { if (value.planId !== key) invalid('Checkpoint key does not match plan ID.'); }
    else if (value.kind === 'transaction') { if (key !== recoveryTransactionKey(value.id)) invalid('Transaction key does not match ID.'); }
    else if (key !== value.id || key !== recoveryAccountKey(value.chainId, value.from)) invalid('Nonce key does not match account.');
  };
  const load = async () => {
    let text;
    try {
      if ((await stat(filename)).size > MAX_BYTES) throw new Error('Reference store exceeds 32 MiB.');
      text = await readFile(filename, 'utf8');
    } catch (cause) { if (cause.code === 'ENOENT') return { version: 1, kind, records: Object.create(null) }; throw cause; }
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('Reference store exceeds 32 MiB.');
    const state = JSON.parse(text); plain(state, ['version', 'kind', 'records']); plain(state.records);
    if (state.version !== 1 || state.kind !== kind) throw new Error('Reference store identity mismatch.');
    return state;
  };
  const read = async key => {
    const state = await load();
    if (!Object.hasOwn(state.records, key)) return null;
    const value = decode(state.records[key]); identity(key, value); return value;
  };
  const compareAndSwap = async (key, expectedRevision, input) => {
    const next = normalize(input); identity(key, next);
    if (expectedRevision !== null) integer(expectedRevision, kind === 'workflow' ? 1 : 0);
    const held = await lock(directory, timeoutMs);
    let temporary;
    try {
      await fault?.('after-lock', { key, record: normalize(next) });
      const state = await load();
      const previous = Object.hasOwn(state.records, key) ? decode(state.records[key]) : null;
      if (previous) identity(key, previous);
      if ((previous?.revision ?? null) !== expectedRevision) return false;
      if (next.revision !== (expectedRevision === null ? (kind === 'workflow' ? 1 : 0) : expectedRevision + 1)) invalid('CAS must increment revision exactly once.');
      if (previous && kind === 'recovery') {
        if (previous.kind !== next.kind || previous.id !== next.id) invalid('Recovery identity is immutable.');
        if (next.kind === 'transaction' && JSON.stringify(previous.intent, (_key, value) => typeof value === 'bigint' ? value.toString() : value) !== JSON.stringify(next.intent, (_key, value) => typeof value === 'bigint' ? value.toString() : value)) invalid('Transaction intent is immutable.');
        if (next.kind === 'nonce' && (previous.chainId !== next.chainId || previous.from !== next.from)) invalid('Nonce identity is immutable.');
      }
      state.records[key] = encode(next);
      const serialized = JSON.stringify(state);
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Reference store exceeds 32 MiB.');
      temporary = join(directory, `.next-${held.token}`);
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(serialized); await file.sync(); } finally { await file.close(); }
      await fault?.('before-commit', { key, record: normalize(next) });
      await rename(temporary, filename); temporary = undefined; await syncDirectory(directory);
      await fault?.('after-commit', { key, record: normalize(next) });
      return true;
    } finally {
      try { if (temporary) await rm(temporary, { force: true }); } finally { await held.release(); }
    }
  };
  return kind === 'recovery' ? { read, compareAndSwap } : { load: read, compareAndSwap };
}
export const openFileRecoveryStore = (directory, options) => openStore(directory, 'recovery', options);
export const openFileWorkflowStore = (directory, options) => openStore(directory, 'workflow', options);
