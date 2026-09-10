import { DaoShipsError, InMemoryTransactionRecoveryStore, InProcessRecoveryCoordinator,
  sendRecoverableTransaction, inspectRecoveryTransaction, recoveryTransactionKey, recoveryAccountKey, address } from '../../dist/index.js';
import { boundedRead } from './support.mjs';

const ID = 'acceptance/recovery/rpc-ack-loss';
const EVIDENCE_KEY = 'recovery/rpc-ack-loss';
const fail = (message, code = 'INVALID_RESPONSE', details = {}) => { throw new DaoShipsError(code, message, details); };

/** Called only by the explicitly authorized, budgeted Orchard execute harness.
 * Sends one zero-value self-transfer at most. Lost acknowledgements never authorize a resend.
 */
export async function runOrchardRecoveryScenarios({ chain, provider, signer, store, evidence, confirmations = 2, timeoutMs = 180_000 }) {
  if (!Number.isSafeInteger(confirmations) || confirmations < 1 || confirmations > 100
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) fail('Invalid recovery scenario bounds.', 'INVALID_ARGUMENT');
  if ((await boundedRead(() => provider.getNetwork())).chainId !== 15000n) fail('Recovery acceptance only supports Orchard 15000.', 'CHAIN_MISMATCH');
  const from = address(await boundedRead(() => signer.getAddress()));
  const call = { to: from, data: '0x', value: 0n, operation: 'orchardRecoveryAcknowledgementLoss' };
  const prepare = () => chain.prepareCall(call, from);
  const current = await prepare();
  if (current.chainId !== 15000 || address(current.from) !== from || address(current.to) !== from || current.value !== 0n || current.data !== '0x') fail('Recovery fixture preparation is not the reviewed zero-value self-transfer.');

  // These negative paths never delegate to the real budgeted signer's send method
  // and deliberately use isolated cursors so they cannot poison the live account.
  const unsigned = {};
  for (const mode of ['stale-refresh', 'rejected-signing']) {
    const isolated = new InMemoryTransactionRecoveryStore(); let signingCalls = 0;
    const rejecting = { provider: signer.provider, getAddress: () => signer.getAddress(), estimateGas: request => signer.estimateGas(request),
      async sendTransaction() { signingCalls++; throw Error('Injected unsigned signer refusal'); } };
    let failure;
    try { await sendRecoverableTransaction(current, rejecting, { id: `acceptance/recovery/${mode}`, store: isolated,
      coordinator: new InProcessRecoveryCoordinator(), timeoutMs: 30_000,
      refresh: mode === 'stale-refresh' ? async () => ({ ...current, value: 1n }) : prepare }); }
    catch (cause) { failure = cause; }
    const record = await isolated.read(recoveryTransactionKey(`acceptance/recovery/${mode}`));
    const cursor = await isolated.read(recoveryAccountKey(15000, from));
    if (mode === 'stale-refresh') {
      if (failure?.code !== 'PLAN_CHANGED' || signingCalls !== 0 || record?.status !== 'not_sent' || cursor?.blockedBy !== null) fail('Stale refresh did not stop before signing.');
    } else if (failure?.code !== 'BROADCAST_ERROR' || signingCalls !== 1 || record?.status !== 'unknown' || cursor?.blockedBy !== record.id) fail('Rejected signing did not preserve ambiguous nonce quarantine.');
    unsigned[mode] = { passed: true, actualSignerInvocations: 0, observedStatus: record.status };
  }

  let saved = await store.read(recoveryTransactionKey(ID));
  let journal = await evidence.get(EVIDENCE_KEY);
  if (journal && (journal.id !== ID || journal.chainId !== 15000 || address(journal.from) !== from || typeof journal.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(journal.hash))) fail('Recovery acknowledgement evidence belongs to another scenario.', 'PLAN_CHANGED');
  if (saved && (saved.kind !== 'transaction' || saved.intent.chainId !== 15000 || address(saved.intent.from) !== from || address(saved.intent.to) !== from || saved.intent.data !== '0x' || saved.intent.value !== 0n)) fail('Recorded recovery intent differs from the reviewed scenario.', 'PLAN_CHANGED');
  if (!saved && journal) fail('Broadcast evidence exists without its durable intent; investigate the backend instead of sending again.', 'RECOVERY_BLOCKED', { id: ID, hash: journal.hash });
  const resumed = saved !== null;
  if (!saved) {
    const loseAcknowledgement = { provider: signer.provider, getAddress: () => signer.getAddress(), estimateGas: request => signer.estimateGas(request),
      async sendTransaction(request) {
        const transaction = await signer.sendTransaction(request);
        if (typeof transaction?.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(transaction.hash)) fail('Signer returned no recoverable hash.', 'BROADCAST_ERROR');
        // Independent durable evidence models a wallet journal surviving RPC-response loss.
        await evidence.put(EVIDENCE_KEY, { id: ID, chainId: 15000, from, nonce: request.nonce, hash: transaction.hash, acknowledgementLossInjected: true });
        throw Error('Injected RPC response loss after a durable broadcast hash');
      } };
    let failure;
    try { await sendRecoverableTransaction(current, loseAcknowledgement, { id: ID, store, coordinator: new InProcessRecoveryCoordinator(), refresh: prepare, timeoutMs: 30_000 }); }
    catch (cause) { failure = cause; }
    journal = await evidence.get(EVIDENCE_KEY);
    saved = await store.read(recoveryTransactionKey(ID));
    if (!journal?.acknowledgementLossInjected) throw failure ?? new DaoShipsError('TX_PENDING', 'No durable acknowledgement-loss evidence; inspect the wallet before retrying.', { id: ID });
    if (failure?.code !== 'BROADCAST_ERROR' || saved?.status !== 'unknown' || saved.hash) fail('Injected response loss did not produce the expected recoverable unknown outcome.');
  }
  const hash = saved.hash ?? journal?.hash;
  if (!hash || !journal?.acknowledgementLossInjected || (saved.hash && saved.hash.toLowerCase() !== journal.hash.toLowerCase()) || saved.intent.nonce !== journal.nonce) fail('Uncertain recovery scenario lacks matching independent hash evidence; no resend is allowed.', 'TX_PENDING', { id: ID });
  try { await boundedRead(() => provider.waitForTransaction(hash, confirmations, timeoutMs), timeoutMs); }
  catch { /* The validated RPC inspection below determines the observation, never the wait result alone. */ }
  const observation = await inspectRecoveryTransaction(store, provider, ID, { transactionHash: hash, confirmations, timeoutMs: 30_000 });
  if (observation.outcome !== 'mined') fail('Acknowledgement-loss scenario remains unresolved; resume inspection without resending.', 'TX_PENDING', { id: ID, hash, outcome: observation.outcome });
  const report = { chainId: 15000, unsigned, acknowledgementLoss: { passed: true, id: ID, hash, resumed,
    recoveredWithoutTransactionObject: true, nonce: observation.record.intent.nonce, receipt: observation.record.receipt },
    limitations: ['The acknowledgement loss is deliberately injected after a real send.', 'Repricing and public-network reorg behavior require separate evidence.'] };
  await evidence.put('recovery/report', report);
  return report;
}
