import type { Shard } from 'quais';
import { DaoShipsError } from './errors.js';

type BlockTag = number | 'latest';
interface BlockSource { getBlock(shard: Shard, tag: BlockTag): Promise<unknown> }
type RawSend = (method: string, params: unknown[], shard?: Shard) => Promise<unknown>;

const HASH = /^0x[\da-fA-F]{64}$/, QUANTITY = /^0x[\da-fA-F]+$/;

function quantity(value: unknown): number {
  const parsed = typeof value === 'string' && QUANTITY.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed)) throw new DaoShipsError('INVALID_RESPONSE', 'Raw block has an invalid height or timestamp.');
  return parsed;
}

/** The fields SDK checks read from a block, taken from a raw quai_getBlockByNumber result. */
function rawBlock(raw: unknown, tag: BlockTag) {
  if (!raw || typeof raw !== 'object') throw new DaoShipsError('INVALID_RESPONSE', 'Raw block response is not an object.');
  const block = raw as { hash?: unknown; woHeader?: { number?: unknown; timestamp?: unknown; parentHash?: unknown }; transactions?: unknown };
  if (typeof block.hash !== 'string' || !HASH.test(block.hash) || !block.woHeader || typeof block.woHeader !== 'object'
    || (block.woHeader.parentHash !== undefined && (typeof block.woHeader.parentHash !== 'string' || !HASH.test(block.woHeader.parentHash)))
    || !Array.isArray(block.transactions) || !block.transactions.every(tx => typeof tx === 'string' && HASH.test(tx))) {
    throw new DaoShipsError('INVALID_RESPONSE', 'Raw block response is malformed.');
  }
  const number = quantity(block.woHeader.number);
  if (tag !== 'latest' && number !== tag) throw new DaoShipsError('INVALID_RESPONSE', 'Raw block response is for a different height.', { requested: tag, returned: number });
  return { hash: block.hash, woHeader: { number, timestamp: quantity(block.woHeader.timestamp), parentHash: block.woHeader.parentHash as string | undefined }, transactions: block.transactions as string[] };
}

/**
 * provider.getBlock(), falling back to a raw quai_getBlockByNumber when quais cannot
 * format the block. quais (through 1.0.0-alpha.57) throws BAD_DATA for mainnet blocks
 * more than a few hundred thousand behind the head, whose totalEntropy the node returns
 * as null, so historical reads (receipt blocks, recovery scans) fail on mainnet.
 *
 * getBlock() is tried first, so recent blocks and caller-supplied providers behave
 * exactly as before. The fallback needs the provider's send() (JsonRpcProvider and
 * DaoShipsProvider have it); without one the original error propagates. It returns
 * only hash, woHeader.number/timestamp/parentHash and transaction hashes, which is all
 * SDK checks read, and invents nothing for fields the node omitted.
 */
export async function readBlock<P extends BlockSource>(provider: P, shard: Shard, tag: BlockTag): Promise<Awaited<ReturnType<P['getBlock']>>> {
  try { return await provider.getBlock(shard, tag) as Awaited<ReturnType<P['getBlock']>>; }
  catch (cause) {
    const send = (provider as { send?: unknown }).send;
    if ((cause as { code?: unknown } | null)?.code !== 'BAD_DATA' || typeof send !== 'function') throw cause;
    const raw = await (send as RawSend).call(provider, 'quai_getBlockByNumber', [tag === 'latest' ? 'latest' : `0x${tag.toString(16)}`, false], shard);
    return (raw === null ? null : rawBlock(raw, tag)) as Awaited<ReturnType<P['getBlock']>>;
  }
}
