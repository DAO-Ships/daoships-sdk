import { JsonRpcProvider } from 'quais';
import { DaoShipsError } from './errors.js';

// quais@1.0.0-alpha.53 parses transaction nonces with parseInt(value, 10).
// Convert the RPC quantity to an exact decimal string before its formatter runs.
// Use the same provider for SDK reads, signing, confirmation and recovery.
export function normalizeQuaiTransaction(tx: unknown): unknown {
  if (!tx || typeof tx !== 'object' || !('nonce' in tx) || tx.nonce == null) return tx;
  const value = tx.nonce;
  if (!(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    && !(typeof value === 'string' && value.length <= 16 && /^(?:0x(?:0|[1-9a-fA-F][\da-fA-F]*)|0|[1-9]\d*)$/.test(value))) {
    throw new DaoShipsError('INVALID_RESPONSE', 'RPC transaction nonce is not a valid exact quantity.');
  }
  const nonce = BigInt(value as string | number);
  if (nonce > BigInt(Number.MAX_SAFE_INTEGER)) throw new DaoShipsError('INVALID_RESPONSE', 'RPC transaction nonce exceeds the safe integer range.');
  return { ...tx, nonce: nonce.toString() };
}

export function normalizeQuaiBlock<T extends { transactions?: readonly unknown[]; outboundEtxs?: readonly unknown[] }>(block: T): T {
  return { ...block,
    ...(Array.isArray(block.transactions) ? { transactions: block.transactions.map(normalizeQuaiTransaction) } : {}),
    ...(Array.isArray(block.outboundEtxs) ? { outboundEtxs: block.outboundEtxs.map(normalizeQuaiTransaction) } : {}),
  };
}

/** JsonRpcProvider with exact Quai nonces for pinned quais alpha.53.
 * Supports mainnet and testnets; the caller selects the RPC URL and expected network.
 * Accepts the same constructor arguments and options as quais.JsonRpcProvider.
 */
export class DaoShipsProvider extends JsonRpcProvider {
  override _wrapTransactionResponse(...[transaction, network]: Parameters<JsonRpcProvider['_wrapTransactionResponse']>): ReturnType<JsonRpcProvider['_wrapTransactionResponse']> {
    return super._wrapTransactionResponse(normalizeQuaiTransaction(transaction), network);
  }
  override _wrapBlock(...[block, network]: Parameters<JsonRpcProvider['_wrapBlock']>): ReturnType<JsonRpcProvider['_wrapBlock']> {
    return super._wrapBlock(normalizeQuaiBlock(block), network);
  }
}
