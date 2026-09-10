import test from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sendRecoverableTransaction, inspectRecoveryTransaction, abandonPreparedTransaction,
  recoveryTransactionKey, recoveryAccountKey, InProcessRecoveryCoordinator } from '../dist/transaction-recovery.js';
import { advanceDeploymentWorkflow, reconcileDeploymentWorkflowStep } from '../dist/deployment-workflows.js';
import { assertRecoveryStoreConformance, assertWorkflowStoreConformance } from '../dist/adapter-conformance.js';
import { openFileRecoveryStore, openFileWorkflowStore, recoverFileStoreLock } from './conformance/file-store.mjs';
import { A, prepared, broadcasts, recoveryFixture, workflowFixture } from './conformance/fixture.mjs';

const workerPath = fileURLToPath(new URL('./conformance/worker.mjs', import.meta.url));
async function scenario(work) {
  const directory = await mkdtemp(join(tmpdir(), 'daoships-adapter-process-'));
  const children = [];
  const spawn = options => {
    const child = fork(workerPath, [JSON.stringify({ directory, mode: 'recovery', ...options })], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], execArgv: [] });
    const messages = [], pending = []; let stderr = '', failure;
    const exit = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
    child.stdout.on('data', bytes => { if (bytes.length > 65_536) child.kill('SIGKILL'); });
    child.stderr.on('data', bytes => { stderr = (stderr + bytes.toString()).slice(-65_536); });
    const deliver = message => {
      if (message.type === 'fatal') { failure = Error(message.message); for (const waiter of pending.splice(0)) { clearTimeout(waiter.timer); waiter.reject(failure); } return; }
      const waiter = pending.find(item => item.type === message.type);
      if (waiter) { pending.splice(pending.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); }
      else messages.push(message);
    };
    child.on('message', deliver);
    child.on('error', cause => { failure = cause; for (const waiter of pending.splice(0)) { clearTimeout(waiter.timer); waiter.reject(cause); } });
    const wait = type => new Promise((resolve, reject) => {
      const index = messages.findIndex(item => item.type === type);
      if (index >= 0) { resolve(messages.splice(index, 1)[0]); return; }
      if (failure) { reject(failure); return; }
      const waiter = { type, resolve, reject, timer: setTimeout(() => {
        pending.splice(pending.indexOf(waiter), 1);
        reject(Error(`Worker ${child.pid} timed out waiting for ${type}: ${stderr}`));
      }, 15_000) };
      pending.push(waiter);
    });
    const handle = { child, exit, wait, async start() { await wait('ready'); child.send({ go: true }); },
      async stop() {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        await exit;
        for (const waiter of pending.splice(0)) { clearTimeout(waiter.timer); waiter.reject(Error('Worker stopped.')); }
      } };
    children.push(handle); return handle;
  };
  try { return await work({ directory, spawn }); }
  finally { await Promise.all(children.map(child => child.stop())); await rm(directory, { recursive: true, force: true }); }
}
async function crash(worker, storeDirectory) {
  await worker.start(); const boundary = await worker.wait('boundary');
  assert.equal(boundary.pid, worker.child.pid);
  worker.child.kill('SIGKILL'); assert.equal((await worker.exit).signal, 'SIGKILL');
  let owner;
  try { owner = JSON.parse(await readFile(join(storeDirectory, '.lock', 'owner.json'), 'utf8')); }
  catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
  if (owner) { assert.equal(owner.pid, boundary.pid); await recoverFileStoreLock(storeDirectory, boundary.pid); }
}
async function send(directory, id) {
  const store = await openFileRecoveryStore(join(directory, 'recovery'));
  const { signer } = recoveryFixture(directory, id);
  return sendRecoverableTransaction(prepared, signer, { id, store, coordinator: new InProcessRecoveryCoordinator(), refresh: async () => prepared });
}

test('file adapters pass consumer conformance across reopened durable instances', () => scenario(async ({ directory }) => {
  const recovery = await assertRecoveryStoreConformance(() => openFileRecoveryStore(join(directory, 'recovery')), { namespace: 'process-driver', contenders: 4 });
  const workflow = await assertWorkflowStoreConformance(() => openFileWorkflowStore(join(directory, 'workflow')), { namespace: 'process-driver', contenders: 4 });
  assert.equal(recovery.keys.length, 4); assert.equal(workflow.keys.length, 2);
}));

test('six real processes racing one intent cannot broadcast it twice', () => scenario(async ({ directory, spawn }) => {
  const workers = Array.from({ length: 6 }, () => spawn({ id: 'same-intent' }));
  await Promise.all(workers.map(worker => worker.wait('ready')));
  for (const worker of workers) worker.child.send({ go: true });
  const results = await Promise.all(workers.map(worker => worker.wait('result')));
  assert.equal(results.filter(result => result.outcome === 'submitted').length, 1);
  assert.equal((await broadcasts(directory)).length, 1);
  assert.ok(results.filter(result => result.outcome === 'error').every(result => ['RECOVERY_CONFLICT', 'RECOVERY_BLOCKED'].includes(result.code)));
  const reopened = await openFileRecoveryStore(join(directory, 'recovery'));
  assert.equal((await reopened.read(recoveryTransactionKey('same-intent'))).intent.value, 1n << 200n);
}));

test('distinct process intents and a restarted sender share one durable nonce floor despite stale RPC counts', () => scenario(async ({ directory, spawn }) => {
  const workers = Array.from({ length: 6 }, (_, index) => spawn({ id: `parallel-${index}` }));
  await Promise.all(workers.map(worker => worker.wait('ready')));
  for (const worker of workers) worker.child.send({ go: true });
  const results = await Promise.all(workers.map(worker => worker.wait('result')));
  const sent = await broadcasts(directory), winners = results.filter(result => result.outcome === 'submitted');
  assert.ok(winners.length >= 1); assert.equal(sent.length, winners.length);
  assert.deepEqual(sent.map(row => row.nonce).sort((a, b) => a - b), Array.from({ length: sent.length }, (_, index) => index));
  const restarted = await send(directory, 'after-restart');
  assert.equal(restarted.record.intent.nonce, sent.length);
}));

test('killing a writer before commit preserves the old snapshot and unused nonce', () => scenario(async ({ directory, spawn }) => {
  const storeDirectory = join(directory, 'recovery');
  await crash(spawn({ id: 'before-commit', boundary: 'before-commit:broadcasting' }), storeDirectory);
  const store = await openFileRecoveryStore(storeDirectory);
  assert.equal((await store.read(recoveryTransactionKey('before-commit'))).status, 'prepared');
  assert.equal((await store.read(recoveryAccountKey(9, A))).blockedBy, 'before-commit');
  assert.equal((await broadcasts(directory)).length, 0);
  await abandonPreparedTransaction(store, 'before-commit');
  assert.equal((await send(directory, 'after-abandon')).record.intent.nonce, 0);
}));

test('killing after the broadcast marker never treats absent network evidence as permission to retry', () => scenario(async ({ directory, spawn }) => {
  const storeDirectory = join(directory, 'recovery');
  await crash(spawn({ id: 'marked', boundary: 'after-commit:broadcasting' }), storeDirectory);
  const store = await openFileRecoveryStore(storeDirectory), { provider } = recoveryFixture(directory, 'marked');
  assert.equal((await store.read(recoveryTransactionKey('marked'))).status, 'broadcasting');
  const observation = await inspectRecoveryTransaction(store, provider, 'marked');
  assert.equal(observation.outcome, 'unknown'); assert.equal((await broadcasts(directory)).length, 0);
  await assert.rejects(send(directory, 'bypass'), { code: 'RECOVERY_BLOCKED' });
  await assert.rejects(abandonPreparedTransaction(store, 'marked'), { code: 'RECOVERY_BLOCKED' });
}));

for (const boundary of ['after-broadcast', 'after-commit:submitted', 'after-commit:nonce-released']) {
  test(`process death at ${boundary} recovers the original broadcast without repeating it`, () => scenario(async ({ directory, spawn }) => {
    const storeDirectory = join(directory, 'recovery');
    await crash(spawn({ id: 'recover-me', boundary }), storeDirectory);
    const ledger = await broadcasts(directory); assert.equal(ledger.length, 1);
    const store = await openFileRecoveryStore(storeDirectory), { provider } = recoveryFixture(directory, 'recover-me');
    const observed = await inspectRecoveryTransaction(store, provider, 'recover-me', { transactionHash: ledger[0].hash });
    assert.equal(observed.outcome, 'mined'); assert.equal(observed.record.hash, ledger[0].hash);
    await assert.rejects(send(directory, 'recover-me'), { code: 'RECOVERY_CONFLICT' });
    assert.equal((await broadcasts(directory)).length, 1);
    assert.equal((await send(directory, 'next-intent')).record.intent.nonce, 1);
  }));
}

test('a real committed write with a lost acknowledgement is recovered after process restart', () => scenario(async ({ directory, spawn }) => {
  const worker = spawn({ id: 'lost-ack', boundary: 'after-commit:submitted', lostAck: true });
  await worker.start(); const result = await worker.wait('result');
  assert.equal(result.code, 'PERSISTENCE_ERROR'); assert.equal((await worker.exit).code, 0);
  const store = await openFileRecoveryStore(join(directory, 'recovery')), { provider } = recoveryFixture(directory, 'lost-ack');
  assert.equal((await store.read(recoveryAccountKey(9, A))).blockedBy, 'lost-ack');
  assert.equal((await inspectRecoveryTransaction(store, provider, 'lost-ack')).outcome, 'mined');
  assert.equal((await broadcasts(directory)).length, 1);
}));

for (const boundary of ['after-broadcast', 'after-commit:submitted', 'after-commit:verified']) {
  test(`deployment executor recovery after ${boundary} reuses its durable receipt without invoking the executor again`, () => scenario(async ({ directory, spawn }) => {
    const storeDirectory = join(directory, 'workflow');
    await crash(spawn({ mode: 'workflow', boundary }), storeDirectory);
    const ledger = await broadcasts(directory); assert.equal(ledger.length, 1);
    const store = await openFileWorkflowStore(storeDirectory), { plan, provider, executors } = workflowFixture(directory);
    const checkpoint = await store.load(plan.id);
    if (checkpoint.steps.create.status !== 'verified') {
      const recovered = await reconcileDeploymentWorkflowStep(plan, store, 'create', ledger[0].hash, provider);
      assert.equal(recovered.steps.create.status, 'verified');
    }
    // The next governance step has no executor; resuming must not call creation again.
    await assert.rejects(advanceDeploymentWorkflow(plan, store, executors, provider), { code: 'INVALID_ARGUMENT' });
    assert.equal((await broadcasts(directory)).length, 1);
  }));
}

test('reference adapter refuses time-based or live-writer lock reclamation', () => scenario(async ({ directory }) => {
  const path = join(directory, 'recovery'); let release, entered;
  const held = new Promise(resolve => { release = resolve; }), ready = new Promise(resolve => { entered = resolve; });
  const store = await openFileRecoveryStore(path, { fault: async stage => { if (stage === 'after-lock') { entered(); await held; } } });
  const key = recoveryAccountKey(9, A);
  const writing = store.compareAndSwap(key, null, { version: 1, kind: 'nonce', id: key, revision: 0, chainId: 9, from: A, nextNonce: 1, blockedBy: 'test' });
  await ready;
  try {
    await assert.rejects(recoverFileStoreLock(path, process.pid), /live process/);
    const competitor = await openFileRecoveryStore(path, { lockTimeoutMs: 5 });
    await assert.rejects(competitor.compareAndSwap(key, null, { version: 1, kind: 'nonce', id: key, revision: 0, chainId: 9, from: A, nextNonce: 1, blockedBy: 'test' }), { code: 'RECOVERY_BLOCKED' });
  } finally { release(); await writing; }
}));
