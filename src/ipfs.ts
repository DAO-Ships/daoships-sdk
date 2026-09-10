import { Fragment, Interface, keccak256, sha256, type JsonFragment } from 'quais';
import { DaoShipsError } from './errors.js';
import { hex, type Hex } from './values.js';
import { validateAllowlistCid } from './ipfs-cid.js';
import { bounded, positive, streamedBytes, type DataReadOptions } from './data-transport.js';

export const IPFS_GATEWAYS = Object.freeze({ contract: 'https://ipfs.qu.ai', content: 'https://ipfs.io' });
export type IpfsPurpose = keyof typeof IPFS_GATEWAYS;

/** Immutable CID or ipfs:// URI, with bounded plain path segments. No IPNS or URL query forwarding. */
export function resolveIpfsUrl(resource: string, purpose: IpfsPurpose = 'content', gateway?: string): string {
  if (typeof purpose !== 'string' || !Object.hasOwn(IPFS_GATEWAYS, purpose) || typeof resource !== 'string' || resource.length > 2048) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an IPFS resource and contract/content purpose.');
  }
  const parts = resource.replace(/^ipfs:\/\/(?:ipfs\/)?/, '').split('/');
  const cid = validateAllowlistCid(parts.shift()!);
  const path = parts.map(part => {
    let segment: string;
    try { segment = decodeURIComponent(part); }
    catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid IPFS path encoding.'); }
    if (!segment || segment === '.' || segment === '..' || /[\\/\x00-\x20\x7f?#%]/.test(segment)) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'IPFS path contains an unsafe segment.');
    }
    return encodeURIComponent(segment);
  });
  let url: URL;
  try { url = new URL(gateway ?? IPFS_GATEWAYS[purpose]); }
  catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid IPFS gateway URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an HTTP(S) gateway without credentials, query or fragment.');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '').replace(/\/ipfs$/, '')}/ipfs/${[cid, ...path].join('/')}`;
  return url.href;
}

export interface IpfsReadOptions extends DataReadOptions {
  resource: string;
  gateway?: string;
  fetch?: typeof globalThis.fetch;
  /** Defaults to 2 MiB, at most 16 MiB. */
  maxBytes?: number;
  /** Trusted SHA-256 of the raw response bytes; this is not a dag-pb CID digest. */
  expectedSha256?: string;
}
function digest(value: string): string {
  if (typeof value !== 'string' || !/^0x[\da-fA-F]{64}$/.test(value)) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a 32-byte trusted content hash.');
  return value.toLowerCase();
}
interface IpfsBytes { bytes: Uint8Array; sha256: Hex; url: string; integrity: 'unverified-gateway' | 'expected-sha256' }
async function read<T>(options: IpfsReadOptions, purpose: IpfsPurpose, transform: (result: IpfsBytes) => T): Promise<T> {
  const url = resolveIpfsUrl(options.resource, purpose, options.gateway);
  const maxBytes = positive(options.maxBytes ?? 2_097_152, 'maxBytes', 16_777_216);
  const expected = options.expectedSha256 === undefined ? undefined : digest(options.expectedSha256);
  const fetcher = options.fetch ?? globalThis.fetch;
  if (typeof fetcher !== 'function') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an IPFS fetch implementation.');
  return bounded(async signal => {
    const bytes = await streamedBytes(await fetcher(url, { method: 'GET', headers: { Accept: 'application/json, text/plain, application/octet-stream' }, redirect: 'error', credentials: 'omit', signal }), maxBytes, signal);
    const actual = sha256(bytes);
    if (expected !== undefined && actual !== expected) throw new DaoShipsError('HASH_MISMATCH', 'IPFS bytes differ from the trusted SHA-256 hash.');
    return transform({ bytes, sha256: actual as Hex, url, integrity: expected === undefined ? 'unverified-gateway' : 'expected-sha256' });
  }, options);
}
function text(bytes: Uint8Array): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new DaoShipsError('INVALID_RESPONSE', 'IPFS document is not valid UTF-8.'); }
}
function json(bytes: Uint8Array): unknown {
  try { return JSON.parse(text(bytes)); }
  catch { throw new DaoShipsError('INVALID_RESPONSE', 'IPFS document is not valid UTF-8 JSON.'); }
}

/** Metadata/allowlists/media JSON uses ipfs.io. A successful gateway fetch alone is not CID verification. */
export async function fetchIpfsJson(options: IpfsReadOptions) {
  return read(options, 'content', result => ({ value: json(result.bytes), sha256: result.sha256, url: result.url, integrity: result.integrity }));
}

/** Read an ABI array, artifact.abi, or Solidity metadata.output.abi through ipfs.qu.ai. */
export async function fetchIpfsAbi(options: IpfsReadOptions) {
  return read(options, 'contract', result => {
    const value = json(result.bytes);
    const object = value && typeof value === 'object' ? value as Record<string, unknown> : {};
    const output = object.output && typeof object.output === 'object' ? object.output as Record<string, unknown> : {};
    const abi = Array.isArray(value) ? value : object.abi ?? output.abi;
    if (!Array.isArray(abi) || abi.length === 0 || abi.length > 2048 || abi.some(fragment => !fragment || typeof fragment !== 'object'
      || !['function', 'event', 'error', 'constructor', 'fallback', 'receive'].includes(fragment.type))) {
      throw new DaoShipsError('INVALID_RESPONSE', 'IPFS document does not contain a bounded ABI.');
    }
    const pending: { value: unknown; depth: number }[] = [{ value: abi, depth: 0 }];
    let nodes = 0;
    while (pending.length) {
      const item = pending.pop()!;
      if (++nodes > 16384 || item.depth > 32) throw new DaoShipsError('INVALID_RESPONSE', 'IPFS ABI exceeds the complexity limit.');
      if (item.value && typeof item.value === 'object') {
        for (const [key, child] of Object.entries(item.value)) {
          if (key === 'type' && (typeof child !== 'string' || child.length > 256 || (child.match(/\[/g)?.length ?? 0) > 32)) {
            throw new DaoShipsError('INVALID_RESPONSE', 'IPFS ABI type exceeds the complexity limit.');
          }
          pending.push({ value: child, depth: item.depth + 1 });
        }
      }
    }
    try {
      if (new Interface((abi as JsonFragment[]).map(fragment => Fragment.from(fragment))).fragments.length !== abi.length) throw Error('Incomplete ABI');
    } catch { throw new DaoShipsError('INVALID_RESPONSE', 'IPFS ABI contains invalid fragments.'); }
    return { abi: abi as JsonFragment[], sha256: result.sha256, url: result.url, integrity: result.integrity };
  });
}

/** Creation/runtime bytes require an independently trusted keccak256 hash before use. */
export async function fetchIpfsBytecode(options: IpfsReadOptions & { expectedKeccak256: string }) {
  const expected = digest(options.expectedKeccak256);
  return read(options, 'contract', result => {
    let code: Hex;
    try { code = hex(text(result.bytes).trim()); }
    catch { throw new DaoShipsError('INVALID_RESPONSE', 'Expected a UTF-8 hex bytecode document.'); }
    if (code === '0x' || keccak256(code) !== expected) throw new DaoShipsError('HASH_MISMATCH', 'IPFS bytecode differs from the trusted keccak256 hash.');
    return { bytecode: code, keccak256: expected as Hex, sha256: result.sha256, url: result.url, integrity: 'expected-keccak256' as const };
  });
}
