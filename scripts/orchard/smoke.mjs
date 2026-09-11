import { resolve } from 'node:path';
import { Wallet, getAddress } from 'quais';
import { OrchardProvider } from './provider.mjs';
import { DaoShipsChain, DaoShipsError, isCyprus1Address } from '../../dist/index.js';
import { openFileRecoveryStore } from '../conformance/file-store.mjs';
import { inspectOrchard } from './runner.mjs';
import { runOrchardRecoveryScenarios } from './recovery-scenarios.mjs';
import { boundedReadProvider, evidenceHash, loadWalletKeys, openEvidence } from './support.mjs';

const fail = (message, code = 'INVALID_ARGUMENT') => { throw new DaoShipsError(code, message); };

/** Exactly one zero-value self-transfer per evidence directory, subject to configured fee bounds. */
export function createSmokeSigner(wallet, provider, config, evidence) {
  return {
    provider,
    getAddress: () => wallet.getAddress(),
    estimateGas: request => wallet.estimateGas(request),
    async sendTransaction(request) {
      const tx = await wallet.populateQuaiTransaction(request);
      if ((await provider.getNetwork()).chainId !== 15000n || tx.chainId !== 15000n) fail('Smoke transactions require Orchard.', 'CHAIN_MISMATCH');
      if (getAddress(tx.from) !== wallet.address || getAddress(tx.to) !== wallet.address || BigInt(tx.value ?? 0) !== 0n || tx.data !== '0x') fail('Smoke transactions must be zero-value self-transfers.');
      const gas = BigInt(tx.gasLimit ?? 0), fee = BigInt(tx.gasPrice ?? tx.maxFeePerGas ?? 0) + BigInt(tx.minerTip ?? 0);
      if (gas <= 0n || fee <= 0n || gas > config.maxGasLimit || fee > config.maxFeePerGas) fail('Smoke transaction exceeds configured gas or fee bounds.');
      if (await provider.getBalance(wallet.address) < gas * fee) fail('Fund the Orchard account before running the smoke test.');
      if (await evidence.get('smoke-send-attempt')) fail('The smoke transaction was already attempted; reconcile its existing evidence.', 'RECOVERY_BLOCKED');
      await evidence.put('smoke-send-attempt', { nonce: tx.nonce, at: new Date().toISOString() });
      return wallet.sendTransaction(tx);
    },
  };
}

export async function executeOrchardSmoke(config, { keysFile, evidenceDirectory = 'orchard-evidence/smoke', environment = process.env } = {}) {
  const keys = await loadWalletKeys(keysFile, { environment, requireMember: false });
  let wallet;
  try { wallet = new Wallet(keys.ORCHARD_OWNER_PRIVATE_KEY); }
  catch { fail('ORCHARD_PRIVATE_KEY must be a valid private key.'); }
  if (!isCyprus1Address(wallet.address)) fail('The funded account must be a Cyprus-1 Quai account.');
  const evidence = await openEvidence(evidenceDirectory), unlock = await evidence.lock();
  let provider;
  try {
    provider = boundedReadProvider(new OrchardProvider(config.rpcUrl, undefined, { usePathing: true }));
    wallet = wallet.connect(provider);
    const identity = { mode: 'smoke', config, account: wallet.address }, previous = await evidence.get('smoke-identity');
    if (previous && evidenceHash(previous) !== evidenceHash(identity)) fail('This evidence directory belongs to a different smoke configuration or account.');
    await evidence.put('smoke-identity', identity);
    const readiness = await inspectOrchard(config, provider);
    await evidence.put('startup', readiness);
    const recovery = await openFileRecoveryStore(resolve(evidence.root, 'recovery'));
    const scenarios = await runOrchardRecoveryScenarios({
      chain: new DaoShipsChain(provider, 15000), provider,
      signer: createSmokeSigner(wallet, provider, config, evidence), store: recovery, evidence,
      confirmations: config.confirmations, timeoutMs: config.waitTimeoutMs,
    });
    const report = { status: 'completed', mode: 'smoke', chainId: 15000, account: wallet.address,
      checkedBlock: readiness.discovered.blockNumber, scenarios, completedAt: new Date().toISOString() };
    await evidence.put('report', report);
    return report;
  } finally {
    try { provider?.destroy(); } finally { await unlock(); }
  }
}
