import { open, rename, mkdir, rm, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { ContractFactory, toBeHex, getAddress } from 'quais';
import { DaoShipsError, isCyprus1Address } from '../../dist/index.js';

const fail = message => { throw new DaoShipsError('INVALID_ARGUMENT', message); };
export const SCENARIOS = Object.freeze([
  'launch/direct: independent existing-vault bootstrap', 'launch/existing-vault: combined existing-vault bootstrap',
  'launch/new-vault: atomic DAO and vault',
  ...['Onboarder', 'ERC20Tribute', 'NFTGated', 'Signal', 'Timelock', 'Vesting', 'Budget', 'Subscription'].map(kind => `navigator/${kind}: native CREATE and DAO governance activation`),
  'recovery: stale-plan and signer-refusal checks; one zero-value transfer with injected acknowledgement loss and restart reconciliation',
]);
export function encodeEvidence(value) { return JSON.stringify(value, (_key, item) => typeof item === 'bigint' ? { $bigint: item.toString() } : item, 2); }
export function decodeEvidence(text) {
  if (text.length > 16_777_216) fail('Evidence file exceeds 16 MiB.');
  return JSON.parse(text, (_key, item) => {
    if (item && typeof item === 'object' && Object.hasOwn(item, '$bigint')) {
      if (Object.keys(item).length !== 1 || typeof item.$bigint !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(item.$bigint)) fail('Invalid bigint evidence.');
      return BigInt(item.$bigint);
    }
    return item;
  });
}
export function evidenceHash(value) { return createHash('sha256').update(encodeEvidence(value)).digest('hex'); }
export async function readBounded(file, limit = 16_777_216) {
  const handle = await open(file, 'r');
  try { const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) fail('Expected a bounded regular file.'); return await handle.readFile('utf8'); }
  finally { await handle.close(); }
}
/** Test-run evidence only; directory must be controlled by this dedicated harness. */
export async function openEvidence(directory) {
  const root = resolve(directory); await mkdir(root, { recursive: true, mode: 0o700 });
  if ((await lstat(root)).isSymbolicLink()) fail('Evidence directory cannot be a symlink.');
  const fileFor = key => join(root, `${evidenceHash(key)}.json`);
  return {
    root,
    async get(key) { try { return decodeEvidence(await readBounded(fileFor(key))); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async put(key, value) {
      const file = fileFor(key), temporary = `${file}.${process.pid}.tmp`, data = encodeEvidence(value);
      if (data.length > 16_777_216) fail('Evidence exceeds 16 MiB.');
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(data); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
      const directoryHandle = await open(dirname(file), 'r'); try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    },
    async lock() {
      const file = join(root, 'session.lock');
      const handle = await open(file, 'wx', 0o600).catch(error => { if (error.code === 'EEXIST') fail('Evidence session is locked. Prove the prior process exited before manually removing session.lock.'); throw error; });
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); await handle.sync(); } finally { await handle.close(); }
      return () => rm(file);
    },
  };
}
export function validateConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.chainId !== 15000 || input.schema !== 'testnet') fail('Orchard acceptance requires chainId 15000 and testnet schema.');
  const allowed = ['chainId', 'schema', 'rpcUrl', 'deployment', 'poster', 'vaultProxyArtifact', 'confirmations', 'maxTransactions', 'maxGasLimit', 'maxFeePerGas', 'maxValuePerTransaction', 'waitTimeoutMs', 'saltStart', 'contractsReviewed'];
  if (Object.keys(input).some(key => !allowed.includes(key))) fail('Unknown configuration field; never put wallet keys in the public configuration.');
  let rpc; try { rpc = new URL(input.rpcUrl); } catch { fail('Expected a public HTTPS RPC URL.'); }
  if (rpc.protocol !== 'https:' || rpc.username || rpc.password || rpc.search || rpc.hash || !['/', '/cyprus1'].includes(rpc.pathname)) fail('RPC must be a public HTTPS origin or Cyprus-1 endpoint without credentials or query parameters.');
  if (input.contractsReviewed !== true) fail('Review and explicitly acknowledge contract identities before using this configuration.');
  const names = ['daoShipAndVaultLauncher', 'daoShipLauncher', 'quaiVaultFactory', 'multisendCallOnly', 'daoShipSingleton', 'sharesSingleton', 'lootSingleton', 'vaultSingleton'];
  const checkedAddress = value => { if (!isCyprus1Address(value) || BigInt(value) <= 1n) fail('Expected a nonzero Cyprus-1 Quai address.'); return getAddress(value); };
  const deployment = Object.fromEntries(names.map(name => [name, checkedAddress(input.deployment?.[name])]));
  const integer = (value, low, high) => { if (!Number.isSafeInteger(value) || value < low || value > high) fail('Invalid configured acceptance limit.'); return value; };
  const amount = value => { if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) fail('Expected a canonical decimal uint256 limit.'); return BigInt(value); };
  if (typeof input.vaultProxyArtifact !== 'string' || !input.vaultProxyArtifact) fail('Expected the reviewed public QuaiVaultProxy artifact path.');
  const config = { chainId: 15000, schema: 'testnet', rpcUrl: rpc.origin, deployment, poster: checkedAddress(input.poster), vaultProxyArtifact: input.vaultProxyArtifact,
    confirmations: integer(input.confirmations ?? 2, 1, 100), maxTransactions: integer(input.maxTransactions ?? 100, 1, 500),
    waitTimeoutMs: integer(input.waitTimeoutMs ?? 180000, 1000, 600000), maxGasLimit: amount(input.maxGasLimit), maxFeePerGas: amount(input.maxFeePerGas),
    maxValuePerTransaction: amount(input.maxValuePerTransaction), saltStart: amount(input.saltStart ?? '0'), contractsReviewed: true };
  if (config.maxGasLimit === 0n || config.maxFeePerGas === 0n) fail('Gas and fee limits must be positive.');
  return Object.freeze({ ...config, deployment: Object.freeze(deployment) });
}
/** Same four-byte suffix search as pinned quais ContractFactory; no provider or signer needed. */
export async function grindCreation(from, nonce, data, { maxAttempts = 10000, signal } = {}) {
  if (!isCyprus1Address(from) || !Number.isSafeInteger(nonce) || nonce < 0 || !/^0x(?:[\da-f]{2})+$/i.test(data)
    || data.length > 2_097_154 || !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 1000000) fail('Invalid bounded native creation input.');
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (signal?.aborted) throw new DaoShipsError('ABORTED', 'Creation grinding cancelled.');
    const salt = toBeHex((BigInt(nonce) + BigInt(attempt)) & 0xffffffffn, 4), creationData = data + salt.slice(2);
    const expectedAddress = ContractFactory.getContractAddress({ from, nonce, data: creationData });
    if (isCyprus1Address(expectedAddress)) return { expectedAddress, creationData, quaiCreation: { nonce, salt }, attempts: attempt + 1 };
    if (attempt % 128 === 127) await new Promise(resolve => setTimeout(resolve, 0));
  }
  fail('No usable native CREATE address within the configured search bound.');
}
export async function loadWalletKeys(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  let content;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) fail('Wallet environment file must be a private bounded regular file (mode 0600).');
    content = await handle.readFile('utf8');
  } finally { await handle.close(); }
  const values = {};
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(ORCHARD_OWNER_PRIVATE_KEY|ORCHARD_MEMBER_PRIVATE_KEY)=(0x[\da-fA-F]{64})$/.exec(line);
    if (!match || Object.hasOwn(values, match[1])) fail('Wallet file must contain only the two explicit Orchard private-key assignments.');
    values[match[1]] = match[2];
  }
  if (Object.keys(values).length !== 2 || values.ORCHARD_OWNER_PRIVATE_KEY === values.ORCHARD_MEMBER_PRIVATE_KEY) fail('Two distinct dedicated Orchard test wallets are required.');
  return values;
}

/** Bound read-only RPC waits; this cannot preempt synchronous JavaScript or cancel a provider. */
export function boundedRead(work, timeoutMs = 30000) {
  const deadline = performance.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const expired = () => new DaoShipsError('TIMEOUT', 'Acceptance RPC read exceeded its deadline.');
    const timer = setTimeout(() => reject(expired()), timeoutMs);
    Promise.resolve().then(work).then(value => { clearTimeout(timer); if (performance.now() >= deadline) reject(expired()); else resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
export function boundedReadProvider(provider) {
  const reads = new Set(['getNetwork', 'getBlock', 'getCode', 'getLogs', 'getTransaction', 'getTransactionReceipt', 'getTransactionCount', 'getBalance', 'getFeeData', 'estimateGas', 'call', 'createAccessList']);
  const bound = new Map();
  return new Proxy(provider, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== 'function') return value;
    if (!bound.has(key)) bound.set(key, reads.has(key) ? (...args) => boundedRead(() => value.apply(target, args)) : value.bind(target));
    return bound.get(key);
  } });
}
