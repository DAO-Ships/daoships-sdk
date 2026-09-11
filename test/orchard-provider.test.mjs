import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DaoShipsProvider, OrchardProvider } from '../dist/index.js';
import { normalizeQuaiTransaction, normalizeQuaiBlock } from '../dist/provider.js';

const A = '0x0011111111111111111111111111111111111111', H = '0x' + '11'.repeat(32);
const transaction = { type: '0x0', hash: H, from: A, to: A, nonce: '0x1a3b', gas:'0x8340', gasPrice:'0x47868c00',
  value:'0x0', input:'0x', chainId:'0x3a98', blockNumber:'0x76b846', blockHash:H, transactionIndex:'0x0', accessList:[] };

test('shared provider preserves mainnet/testnet identity and retains the Orchard compatibility alias', () => {
  assert.equal(OrchardProvider, DaoShipsProvider);
  const provider = Object.create(DaoShipsProvider.prototype);
  for (const chainId of ['0x9', '0x3a98']) {
    const parsed = provider._wrapTransactionResponse({ ...transaction, chainId });
    assert.equal(parsed.chainId, BigInt(chainId));
    assert.equal(parsed.nonce, 6715);
  }
});

test('Orchard transaction parsing preserves hexadecimal and zero nonces through real quais formatting', () => {
  // This stateless formatting hook needs no transport. The real constructor starts RPC discovery.
  const provider = Object.create(DaoShipsProvider.prototype);
  for (const [nonce, expected] of [['0x1a3b', 6715], ['0x0', 0], [0, 0], [6715, 6715], ['6715',6715]]) {
    const raw = { ...transaction, nonce };
    const parsed = provider._wrapTransactionResponse(raw);
    assert.equal(parsed.nonce, expected);
    assert.equal(parsed.hash, H); assert.equal(parsed.chainId, 15000n);
    assert.equal(raw.nonce, nonce);
  }
});

test('Orchard block normalization handles full transactions, external transactions and hashes without mutation', () => {
  const block = { transactions: [transaction, H, {type:'0x2',hash:H}], outboundEtxs:[{ ...transaction, type:'0x1', nonce:'0x10' }] };
  const normalized = normalizeQuaiBlock(block);
  assert.equal(normalized.transactions[0].nonce,'6715');
  assert.equal(normalized.outboundEtxs[0].nonce,'16');
  assert.equal(normalized.transactions[1],H);
  assert.deepEqual(normalized.transactions[2],{type:'0x2',hash:H});
  assert.equal(block.transactions[0].nonce,'0x1a3b');
  assert.equal(block.outboundEtxs[0].nonce,'0x10');
  assert.equal(normalizeQuaiTransaction(null),null);
});

test('Orchard parsing rejects malformed and unsafe nonces instead of rounding or inventing them', () => {
  for (const nonce of [-1, 0.5, NaN, Number.MAX_SAFE_INTEGER + 1, '0x20000000000000', '9007199254740992', '12garbage', '1e3', '0x', {}, '0x00']) {
    assert.throws(() => normalizeQuaiTransaction({ ...transaction, nonce }), {code:'INVALID_RESPONSE'});
  }
});

test('public Orchard provider preserves the recorded smoke nonce in a real prefetched block', async () => {
  // Public RPC response captured 2026-09-11; unrelated transactions/ETXs/uncles
  // removed. Keep the real header and smoke transaction to exercise quais formatting.
  const raw = JSON.parse(await readFile(new URL('./fixtures/orchard-block-7780422.json', import.meta.url), 'utf8'));
  const block = Object.create(DaoShipsProvider.prototype)._wrapBlock(raw);
  assert.equal(block.woHeader.number, 7780422);
  assert.equal(block.prefetchedTransactions[0].nonce, 6715);
  assert.equal(block.prefetchedTransactions[0].hash, '0x000f0022a4519b61544f491aedcb7bec94d6ef89cb08c1056cd89fea02d6400d');
  assert.equal(raw.transactions[0].nonce, '0x1a3b');
});

test('shared provider formats a real mainnet transaction and prefetched block without losing the nonce', async () => {
  // Public mainnet RPC response captured 2026-09-11, reduced to one Quai transaction.
  const raw = JSON.parse(await readFile(new URL('./fixtures/mainnet-block-10044857.json', import.meta.url), 'utf8'));
  const provider = Object.create(DaoShipsProvider.prototype);
  const block = provider._wrapBlock(raw);
  const transaction = provider._wrapTransactionResponse(raw.transactions[0]);
  assert.equal(block.woHeader.number, 10044857);
  for (const tx of [transaction, block.prefetchedTransactions[0]]) {
    assert.equal(tx.chainId, 9n);
    assert.equal(tx.nonce, 25);
    assert.equal(tx.hash, '0x00250001a57b3305e327c39fbfce466f57767e341a3ec1c57a35ff4b9ea8ce9b');
  }
  assert.equal(raw.transactions[0].nonce, '0x19');
});
