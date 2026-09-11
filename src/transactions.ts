import { Interface, type Provider, type Signer, type TransactionResponse } from 'quais';
import { DaoShipsError } from './errors.js';
import type { PreparedTransaction } from './chain.js';
import type { Receipt } from './receipts.js';
import { address, hex, uint } from './values.js';
const PROCESS_SELECTOR = new Interface(['function processProposal(uint32,bytes)']).getFunction('processProposal')!.selector;

export type TransactionSigner = Pick<Signer, 'getAddress' | 'estimateGas' | 'sendTransaction'> & {
  provider: Pick<Provider, 'getNetwork'> | null;
};
export interface SendOptions {
  /** Re-run the domain preparation against current state immediately before signing. */
  refresh: () => Promise<PreparedTransaction>;
  /** Persist the broadcast hash before any confirmation wait. Failure includes the hash. */
  onSubmitted: (record: { hash: string; chainId: number; from: string; to: string; operation: string }) => void | Promise<void>;
  /** Percent of estimated gas, rounded up. Defaults to 150 for processProposal, 120 otherwise. */
  gasMultiplierPercent?: bigint;
  /** Explicit account nonce for a caller-owned durable coordinator. */
  nonce?: number;
}

/** Explicit one-shot broadcast using a caller-owned signer. Never retries a send. */
export async function sendPreparedTransaction(prepared: PreparedTransaction, signer: TransactionSigner, options: SendOptions): Promise<TransactionResponse> {
  if (!signer.provider) throw new DaoShipsError('CHAIN_ERROR', 'Signer must be connected to a provider.');
  if (typeof options.refresh !== 'function' || typeof options.onSubmitted !== 'function') {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Refresh and transaction persistence callbacks are required.');
  }
  const provider = signer.provider;
  const { refresh, onSubmitted, gasMultiplierPercent, nonce } = options;
  if (nonce !== undefined && (!Number.isSafeInteger(nonce) || nonce < 0 || nonce >= Number.MAX_SAFE_INTEGER)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Nonce must be a nonnegative safe integer below Number.MAX_SAFE_INTEGER.');
  }
  const expected = { chainId: prepared.chainId, from: address(prepared.from), to: address(prepared.to),
    data: hex(prepared.data), value: uint(prepared.value), operation: prepared.operation };
  if (!Number.isSafeInteger(expected.chainId) || expected.chainId < 1) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Prepared chainId must be a positive safe integer.');
  }
  const multiplier = uint(gasMultiplierPercent ?? (expected.data.slice(0, 10).toLowerCase() === PROCESS_SELECTOR ? 150n : 120n));
  if (multiplier < 100n || multiplier > 1000n) throw new DaoShipsError('INVALID_ARGUMENT', 'Gas multiplier must be 100–1000 percent.');
  const fresh = await refresh();
  if (fresh.chainId !== expected.chainId || address(fresh.from) !== expected.from || address(fresh.to) !== expected.to
    || hex(fresh.data).toLowerCase() !== expected.data.toLowerCase() || uint(fresh.value) !== expected.value) {
    throw new DaoShipsError('PLAN_CHANGED', 'Transaction contents changed during refresh; review the new preparation before sending.');
  }
  const verifySigner = async () => {
    if (signer.provider !== provider) throw new DaoShipsError('CHAIN_MISMATCH', 'Signer provider changed before broadcast.');
    const [account, network] = await Promise.all([signer.getAddress(), provider.getNetwork()]);
    if (signer.provider !== provider) throw new DaoShipsError('CHAIN_MISMATCH', 'Signer provider changed before broadcast.');
    if (address(account) !== expected.from) throw new DaoShipsError('SIGNER_MISMATCH', 'Signer does not match the prepared sender.');
    if (network.chainId !== BigInt(expected.chainId)) throw new DaoShipsError('CHAIN_MISMATCH', 'Signer network does not match the prepared chain.');
  };
  await verifySigner();
  const request = { chainId: BigInt(expected.chainId), from: expected.from, to: expected.to, data: expected.data, value: expected.value, ...(nonce === undefined ? {} : { nonce }) };
  let estimate: bigint;
  try { estimate = uint(await signer.estimateGas({ ...request })); }
  catch (cause) {
    if (cause instanceof DaoShipsError && (cause.code === 'TIMEOUT' || cause.code === 'ABORTED')) throw cause;
    throw new DaoShipsError('CHAIN_ERROR', 'Gas estimation failed; no transaction was sent.', {}, { cause });
  }
  if (estimate === 0n) throw new DaoShipsError('INVALID_RESPONSE', 'Gas estimate must be positive.');
  const gasLimit = uint((estimate * multiplier + 99n) / 100n);
  await verifySigner();
  let transaction: TransactionResponse;
  try { transaction = await signer.sendTransaction({ ...request, gasLimit }); }
  catch (cause) {
    throw new DaoShipsError('BROADCAST_ERROR', 'Broadcast did not return a transaction hash. Check the wallet and chain before retrying.', {}, { cause });
  }
  if (!transaction || typeof transaction.hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(transaction.hash)) {
    throw new DaoShipsError('BROADCAST_ERROR', 'Broadcast returned no valid transaction hash. Check the wallet and chain before retrying.');
  }
  const submittedHash = transaction.hash;
  try {
    await onSubmitted({ hash: submittedHash, chainId: expected.chainId,
      from: expected.from, to: expected.to, operation: expected.operation });
  } catch (cause) {
    throw new DaoShipsError('PERSISTENCE_ERROR', 'Transaction was broadcast but its hash could not be persisted.',
      { hash: submittedHash, chainId: expected.chainId }, { cause });
  }
  return transaction;
}

function matchesReceiptHash(receipt: Receipt, hash: string): boolean {
  return receipt.hash === undefined || (typeof receipt.hash === 'string' && receipt.hash.toLowerCase() === hash.toLowerCase());
}

export interface ConfirmationOptions { timeoutMs?: number; confirmations?: number; signal?: AbortSignal }
export interface WaitableTransaction<R extends Receipt = Receipt> {
  hash: string;
  wait(confirmations?: number, timeoutMs?: number): Promise<R | null>;
}

/** Confirmation timeout/cancellation means unknown outcome, never permission to resubmit. */
export async function confirmTransaction<R extends Receipt>(transaction: WaitableTransaction<R>, options: ConfirmationOptions = {}): Promise<R> {
  const { signal } = options;
  const timeoutMs = options.timeoutMs ?? 90_000;
  const confirmations = options.confirmations ?? 1;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647
    || !Number.isSafeInteger(confirmations) || confirmations < 1) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Positive confirmation count and timeout are required.');
  }
  const hash = transaction.hash;
  if (typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash)) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a 32-byte transaction hash.');
  const wait = transaction.wait.bind(transaction);
  const details = { hash };
  return new Promise<R>((resolve, reject) => {
    const deadline = performance.now() + timeoutMs;
    let done = false;
    const finish = (error?: unknown, receipt?: R) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (performance.now() >= deadline) error = new DaoShipsError('TX_PENDING', 'Confirmation timed out; the transaction may still confirm.', details);
      if (error) reject(error); else resolve(receipt!);
    };
    const onAbort = () => finish(new DaoShipsError('TX_PENDING', 'Stopped waiting; the transaction may still confirm.', details));
    const timer = setTimeout(() => finish(new DaoShipsError('TX_PENDING', 'Confirmation timed out; the transaction may still confirm.', details)), timeoutMs);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => done ? null : wait(confirmations, timeoutMs)).then(receipt => {
      if (!receipt) finish(new DaoShipsError('TX_PENDING', 'No receipt available; transaction outcome is unknown.', details));
      else if (!matchesReceiptHash(receipt, hash)) finish(new DaoShipsError('TX_PENDING', 'Receipt hash differs from the submitted transaction; inspect both hashes before retrying.', { ...details, receiptHash: receipt.hash }));
      else if (receipt.status === 0) finish(new DaoShipsError('TX_REVERTED', 'Transaction reverted on-chain.', details));
      else if (receipt.status !== 1) finish(new DaoShipsError('TX_PENDING', 'Receipt status is unknown; inspect the transaction before retrying.', details));
      else finish(undefined, receipt);
    }).catch(cause => {
      // quais can reject wait() with a reverted receipt attached instead of returning it.
      const receipt = cause && typeof cause === 'object' ? (cause as { receipt?: Receipt }).receipt : undefined;
      finish(receipt?.status === 0 && matchesReceiptHash(receipt, hash) ? new DaoShipsError('TX_REVERTED', 'Transaction reverted on-chain.', details, { cause })
        : new DaoShipsError('TX_PENDING', 'Confirmation failed; inspect the transaction hash before retrying.', details, { cause }));
    });
  });
}

/** Resume waiting by a previously persisted hash; no signing or resubmission occurs. */
export function resumeTransaction(provider: Pick<Provider, 'waitForTransaction'>, hash: string, options: ConfirmationOptions = {}) {
  if (typeof hash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(hash)) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a 32-byte transaction hash.');
  return confirmTransaction({ hash, wait: (confirmations, timeoutMs) => provider.waitForTransaction(hash, confirmations, timeoutMs) }, options);
}
