import { DaoShipsError } from './errors.js';

/** Supported immutable CID encodings: CIDv0 dag-pb SHA-256 or CIDv1 base32 raw/dag-pb SHA-256. */
export function validateAllowlistCid(cid: string): string {
  if (typeof cid !== 'string' || cid.length > 64) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a supported IPFS CID.');
  let bytes: number[] = [];
  if (/^Qm[1-9A-HJ-NP-Za-km-z]{44}$/.test(cid)) {
    const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let value = 0n;
    for (const character of cid) value = value * 58n + BigInt(alphabet.indexOf(character));
    while (value) { bytes.unshift(Number(value & 255n)); value >>= 8n; }
    if (bytes.length === 34 && bytes[0] === 0x12 && bytes[1] === 0x20) return cid;
  } else if (/^b[a-z2-7]{58}$/.test(cid)) {
    const alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
    let bits = 0, value = 0;
    for (const character of cid.slice(1)) {
      value = (value << 5) | alphabet.indexOf(character); bits += 5;
      if (bits >= 8) { bits -= 8; bytes.push((value >> bits) & 255); }
    }
    if ((value & ((1 << bits) - 1)) === 0 && bytes.length === 36 && bytes[0] === 1 && [0x55, 0x70].includes(bytes[1]!) && bytes[2] === 0x12 && bytes[3] === 0x20) return cid;
  }
  throw new DaoShipsError('INVALID_ARGUMENT', 'Expected CIDv0 or base32 CIDv1 with SHA-256 raw/dag-pb content.');
}
