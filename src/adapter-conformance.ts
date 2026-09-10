import { keccak256, toUtf8Bytes } from 'quais';
import { DaoShipsError } from './errors.js';
import { parseRecoveryRecord, serializeRecoveryRecord, recoveryTransactionKey, recoveryAccountKey,
  type RecoveryRecord, type RecoveryTransactionRecord, type RecoveryNonceRecord, type TransactionRecoveryStore } from './transaction-recovery.js';
import type { DeploymentWorkflowCheckpoint, DeploymentWorkflowStore, DeploymentStepExecutor,
  DeploymentWorkflowPlan, PreparedDeploymentStep } from './deployment-workflows.js';
import { address, type Hex } from './values.js';

/** These checks write synthetic records. Use an isolated disposable backend and a fresh namespace. */
export interface AdapterConformanceOptions {
  namespace: string;
  /** Per operation, including opening an adapter. A timed-out write may still commit. */
  timeoutMs?: number;
  contenders?: number;
}
export interface AdapterConformanceReport {
  adapter: 'recovery-store' | 'workflow-store' | 'deployment-executor';
  namespace: string;
  checks: readonly string[];
  /** Records remain available for inspection; cleanup belongs to the disposable test backend. */
  keys: readonly string[];
  durability: 'not-certified';
}
function fail(check: string, message: string): never {
  throw new DaoShipsError('INVALID_RESPONSE', `Adapter conformance failed: ${message}`, { check });
}
function settings(options: AdapterConformanceOptions) {
  const { namespace } = options, timeoutMs = options.timeoutMs ?? 10_000, contenders = options.contenders ?? 8;
  if (typeof namespace !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(namespace)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000
    || !Number.isSafeInteger(contenders) || contenders < 2 || contenders > 32) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Conformance requires a fresh 1–64 character namespace, a 1–60000ms timeout and 2–32 contenders.');
  }
  const run = <T>(check: string, work: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new DaoShipsError('TIMEOUT', 'Adapter conformance operation timed out; a write may still commit.', { check })), timeoutMs);
    Promise.resolve().then(work).then(value => { clearTimeout(timer); resolve(value); }, cause => { clearTimeout(timer); reject(cause); });
  });
  return { namespace, contenders, run };
}
const HASH = `0x${'11'.repeat(32)}` as Hex;
const ADDRESS = `0x00${'11'.repeat(19)}` as Hex;
function json(value: unknown): string {
  if (typeof value === 'bigint') return `bigint(${value})`;
  if (Array.isArray(value)) return `[${value.map(json).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${json((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'undefined';
}
function report(adapter: AdapterConformanceReport['adapter'], namespace: string, checks: string[], keys: string[]): AdapterConformanceReport {
  return Object.freeze({ adapter, namespace, checks: Object.freeze(checks), keys: Object.freeze(keys), durability: 'not-certified' });
}
interface Store<T> { read(key: string): Promise<T | null>; cas(key: string, revision: number | null, next: T): Promise<boolean> }
interface StoreCases<T extends { revision: number }> {
  adapter: 'recovery-store' | 'workflow-store'; open(): Promise<Store<T>>; keys: [string, string];
  initial(key: string): T; next(record: T): T; mutate(record: T): void; invalid(record: T): T[]; clone(record: T): T;
}
async function storeChecks<T extends { revision: number }>(cases: StoreCases<T>, options: AdapterConformanceOptions): Promise<AdapterConformanceReport> {
  const { namespace, contenders, run } = settings(options), checks: string[] = [];
  const first = await run('open', cases.open), second = await run('reopen', cases.open);
  for (const key of cases.keys) {
    if (await run('fresh-namespace', () => first.read(key)) !== null) fail('fresh-namespace', 'test keys must be absent before any writes.');
  }
  const key = cases.keys[0], initial = cases.initial(key), input = cases.clone(initial);
  const equal = async (check: string, adapter: Store<T>, expected: T) => {
    if (json(await run(check, () => adapter.read(key))) !== json(expected)) fail(check, 'stored record differs from the committed detached value.');
    checks.push(check);
  };
  if (await run('insert', () => first.cas(key, null, input)) !== true) fail('insert', 'initial CAS must return true.');
  cases.mutate(input);
  await equal('detached-write', first, initial);
  const snapshot = await run('snapshot', () => first.read(key));
  if (!snapshot) fail('snapshot', 'committed record disappeared.');
  cases.mutate(snapshot);
  await equal('detached-read', first, initial);
  await equal('cross-instance-read', second, initial);
  const next = cases.next(cases.clone(initial));
  if (await run('update', () => second.cas(key, initial.revision, next)) !== true) fail('update', 'revision update must return true.');
  await equal('cross-instance-update', first, next);
  if (await run('stale-cas', () => first.cas(key, initial.revision, cases.clone(next))) !== false
    || await run('duplicate-insert', () => first.cas(key, null, cases.clone(initial))) !== false) fail('stale-cas', 'stale CAS and duplicate insertion must return false.');
  await equal('stale-cas-preserves-value', first, next);
  for (const invalid of cases.invalid(cases.next(cases.clone(next)))) {
    try {
      if (await run('invalid-update', () => first.cas(key, next.revision, invalid)) !== false) fail('invalid-update', 'malformed or identity-changing updates must not commit.');
    } catch (cause) {
      if (cause instanceof DaoShipsError && (cause.code === 'TIMEOUT' || cause.details.check === 'invalid-update')) throw cause;
      // Rejecting malformed writes is valid; the read below proves no mutation.
    }
    await equal('invalid-update-preserves-value', second, next);
  }
  const reopened = await run('reopen-after-commit', cases.open);
  await equal('reopened-state', reopened, next);
  const workers = await Promise.all(Array.from({ length: contenders }, () => run('open-contender', cases.open)));
  const outcomes = await Promise.all(workers.map(worker => run('competing-cas', () => worker.cas(cases.keys[1], null, cases.initial(cases.keys[1])))));
  if (outcomes.some(value => typeof value !== 'boolean') || outcomes.filter(Boolean).length !== 1) fail('competing-cas', 'exactly one independent contender must win insertion.');
  if (json(await run('race-result', () => first.read(cases.keys[1]))) !== json(cases.initial(cases.keys[1]))) fail('race-result', 'winning record was not preserved.');
  checks.push('single-winner-cas');
  return report(cases.adapter, namespace, checks, cases.keys);
}

/** Adapter instances must address the same disposable backing store. Reopening alone does not certify durability. */
export async function assertRecoveryStoreConformance(open: () => Promise<TransactionRecoveryStore>, options: AdapterConformanceOptions): Promise<AdapterConformanceReport> {
  options = { ...options };
  const { namespace } = settings(options);
  const initial = (key: string): RecoveryTransactionRecord => ({ version: 1, kind: 'transaction', id: key.slice('transaction:'.length), revision: 0,
    status: 'prepared', intent: { chainId: 9, from: ADDRESS, to: ADDRESS, data: '0x', value: 1n << 200n, operation: 'conformance', nonce: 0 } });
  const transactions = await storeChecks<RecoveryRecord>({ adapter: 'recovery-store',
    open: async () => { const store = await open(); return { read: key => store.read(key), cas: (key, revision, next) => store.compareAndSwap(key, revision, next) }; },
    keys: [recoveryTransactionKey(`conformance/${namespace}/record`), recoveryTransactionKey(`conformance/${namespace}/race`)], initial,
    clone: record => parseRecoveryRecord(serializeRecoveryRecord(record)),
    next: record => ({ ...record, revision: record.revision + 1 }),
    mutate: record => { record.revision += 100; if (record.kind === 'transaction') (record.intent as { value: bigint }).value = 1n; },
    invalid: record => [
      { ...record, revision: record.revision + 1 }, { ...record, version: 2 } as unknown as RecoveryRecord,
      { ...record, id: `${record.id}-changed` },
      { ...record, intent: { ...(record as RecoveryTransactionRecord).intent, nonce: 1 } } as RecoveryTransactionRecord,
      { ...record, status: 'mined' } as RecoveryTransactionRecord,
    ],
  }, options);
  const accountKeys = ['record', 'race'].map(suffix => recoveryAccountKey(9, `0x00${keccak256(toUtf8Bytes(`conformance/${namespace}/${suffix}`)).slice(4, 42)}`)) as [string, string];
  const nonces = await storeChecks<RecoveryNonceRecord>({ adapter: 'recovery-store',
    open: async () => { const store = await open(); return { read: async key => await store.read(key) as RecoveryNonceRecord | null, cas: (key, revision, next) => store.compareAndSwap(key, revision, next) }; },
    keys: accountKeys,
    initial: key => ({ version: 1, kind: 'nonce', id: key, revision: 0, chainId: 9, from: address(key.split(':')[2]!), nextNonce: 1, blockedBy: 'conformance' }),
    clone: record => parseRecoveryRecord(serializeRecoveryRecord(record)) as RecoveryNonceRecord,
    next: record => ({ ...record, revision: record.revision + 1, nextNonce: record.nextNonce + 1 }),
    mutate: record => { record.nextNonce += 100; },
    invalid: record => [{ ...record, from: ADDRESS }, { ...record, chainId: 10 }, { ...record, nextNonce: -1 }, { ...record, revision: record.revision + 1 }],
  }, options);
  return report('recovery-store', namespace, [...transactions.checks.map(check => `transaction:${check}`), ...nonces.checks.map(check => `nonce:${check}`)], [...transactions.keys, ...nonces.keys]);
}

/** Check checkpoint CAS, detached reads/writes, immutable plan identity and independent-instance visibility. */
export async function assertWorkflowStoreConformance(open: () => Promise<DeploymentWorkflowStore>, options: AdapterConformanceOptions): Promise<AdapterConformanceReport> {
  options = { ...options };
  const { namespace } = settings(options);
  return storeChecks<DeploymentWorkflowCheckpoint>({ adapter: 'workflow-store',
    open: async () => { const store = await open(); return { read: key => store.load(key), cas: (key, revision, next) => store.compareAndSwap(key, revision, next) }; },
    keys: [keccak256(toUtf8Bytes(`conformance/${namespace}/record`)), keccak256(toUtf8Bytes(`conformance/${namespace}/race`))],
    initial: key => ({ version: 1, planId: key as Hex, revision: 1, steps: { create: { status: 'submitting' } } }),
    clone: record => JSON.parse(JSON.stringify(record)) as DeploymentWorkflowCheckpoint,
    next: record => ({ ...record, revision: record.revision + 1 }),
    mutate: record => { record.revision += 100; record.steps.create = { status: 'submitted', hash: HASH }; },
    invalid: record => [
      { ...record, revision: record.revision + 1 }, { ...record, version: 2 } as unknown as DeploymentWorkflowCheckpoint,
      { ...record, planId: HASH }, { ...record, steps: { create: { status: 'submitted', hash: 'invalid' } } },
    ],
  }, options);
}

export interface ExecutorConformanceFixture {
  executor: DeploymentStepExecutor;
  plan: DeploymentWorkflowPlan;
  stepId: string;
  prepared: PreparedDeploymentStep;
  /** Count entry to broadcast and confirmation-wait operations in the fixture's instrumented transport. */
  observe(): Promise<{ broadcasts: number; waits: number }>;
}
/** Each fixture must use a disposable local/fake transport, never a funded public-chain signer. */
export async function assertDeploymentExecutorConformance(
  createFixture: (scenario: 'success' | 'persistence-failure') => Promise<ExecutorConformanceFixture>,
  options: AdapterConformanceOptions,
): Promise<AdapterConformanceReport> {
  options = { ...options };
  const { namespace, run } = settings(options), checks: string[] = [];
  for (const scenario of ['success', 'persistence-failure'] as const) {
    const fixture = await run('open-executor-fixture', () => createFixture(scenario));
    const step = fixture.plan.steps.find(candidate => candidate.id === fixture.stepId);
    if (!step) throw new DaoShipsError('INVALID_ARGUMENT', 'Executor fixture step does not belong to its plan.');
    let submissions = 0, acknowledged = false, submittedHash: string | undefined, callbackError: unknown;
    const persistenceFailure = new DaoShipsError('PERSISTENCE_ERROR', 'Injected conformance acknowledgement failure.');
    let executionError: unknown, receipt;
    try {
      receipt = await run(scenario, () => fixture.executor.execute(fixture.plan, step, {
        id: `conformance/${namespace}/${scenario}`, prepared: fixture.prepared,
        onSubmitted(hash) {
          submissions++;
          const acknowledgment = (async () => {
            if (submissions !== 1 || !/^0x[\da-fA-F]{64}$/.test(hash)) fail(scenario, 'executor must submit exactly one valid hash.');
            submittedHash = hash.toLowerCase();
            // Allow an executor that forgot to await persistence to reveal its premature wait.
            await new Promise<void>(resolve => setTimeout(resolve, 0));
            const observed = await run('observe-before-acknowledgement', () => fixture.observe());
            if (observed.broadcasts !== 1 || observed.waits !== 0) fail(scenario, 'persist the broadcast hash before starting confirmation.');
            if (scenario === 'persistence-failure') throw persistenceFailure;
            acknowledged = true;
          })();
          // Observe forgotten awaits without creating an unhandled rejection in the host test runner.
          void acknowledgment.catch(cause => { callbackError = cause; });
          return acknowledgment;
        },
      }));
    } catch (cause) { executionError = cause; }
    if (executionError instanceof DaoShipsError && executionError.code === 'TIMEOUT') throw executionError;
    const observed = await run('observe-executor-outcome', () => fixture.observe());
    if (submissions !== 1 || observed.broadcasts !== 1) fail(scenario, 'one execution must broadcast once and report its hash once.');
    if (scenario === 'success') {
      if (executionError || callbackError || !acknowledged || observed.waits !== 1 || !receipt || typeof receipt.hash !== 'string' || receipt.hash.toLowerCase() !== submittedHash || receipt.status !== 1) fail(scenario, 'successful execution must await persistence, then return its matching successful receipt.');
      checks.push('persist-before-confirmation');
    } else {
      if (!executionError || callbackError !== persistenceFailure || observed.waits !== 0) fail(scenario, 'failed persistence must stop confirmation and propagate failure without another send.');
      checks.push('failed-acknowledgement-stops-executor');
    }
  }
  return report('deployment-executor', namespace, checks, []);
}
