import { join } from 'node:path';
import { sendRecoverableTransaction, InProcessRecoveryCoordinator } from '../../dist/transaction-recovery.js';
import { advanceDeploymentWorkflow } from '../../dist/deployment-workflows.js';
import { openFileRecoveryStore, openFileWorkflowStore } from './file-store.mjs';
import { prepared, recoveryFixture, workflowFixture } from './fixture.mjs';

const options = JSON.parse(process.argv[2]);
const send = message => new Promise((resolve, reject) => process.send(message, cause => cause ? reject(cause) : resolve()));
const pause = async boundary => { await send({ type: 'boundary', boundary, pid: process.pid }); await new Promise(() => {}); };
let injected = false;
const fault = async (stage, details) => {
  const record = details.record;
  const status = record.kind === 'nonce' ? (record.blockedBy ? 'nonce-reserved' : 'nonce-released') : record.kind === 'transaction' ? record.status : record.steps.create?.status;
  if (!injected && `${stage}:${status}` === options.boundary) {
    injected = true;
    if (options.lostAck) throw Error('Injected lost commit acknowledgement');
    await pause(options.boundary);
  }
};
try {
  const afterBroadcast = () => options.boundary === 'after-broadcast' ? pause('after-broadcast') : Promise.resolve();
  const store = options.mode === 'workflow'
    ? await openFileWorkflowStore(join(options.directory, 'workflow'), { fault })
    : await openFileRecoveryStore(join(options.directory, 'recovery'), { fault });
  const start = new Promise(resolve => process.once('message', resolve));
  await send({ type: 'ready', pid: process.pid });
  await start;
  try {
    if (options.mode === 'workflow') {
      const { plan, provider, executors } = workflowFixture(options.directory, afterBroadcast);
      const checkpoint = await advanceDeploymentWorkflow(plan, store, executors, provider);
      await send({ type: 'result', outcome: 'verified', checkpoint });
    } else {
      const { signer } = recoveryFixture(options.directory, options.id, afterBroadcast);
      const result = await sendRecoverableTransaction(prepared, signer, { id: options.id, store, coordinator: new InProcessRecoveryCoordinator(), refresh: async () => prepared });
      await send({ type: 'result', outcome: 'submitted', id: options.id, nonce: result.record.intent.nonce, hash: result.record.hash });
    }
  } catch (cause) { await send({ type: 'result', outcome: 'error', code: cause.code, message: cause.message }); }
} catch (cause) { await send({ type: 'fatal', message: cause.stack }); process.exitCode = 1; }
finally { process.disconnect(); }
