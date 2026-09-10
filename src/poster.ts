import { Interface, id } from 'quais';
import { CONTRACT_ABIS } from './abis.js';
import { DaoShipsError } from './errors.js';
import { address, type Hex } from './values.js';
import { validateAllowlistTree, verifyAllowlistRoot, type AllowlistTreeDump } from './allowlist.js';

export const POSTER_TAGS = Object.freeze({
  DAO_PROFILE_INITIAL: 'daoships.dao.profile.initial', DAO_PROFILE: 'daoships.dao.profile',
  DAO_ANNOUNCEMENT: 'daoships.dao.announcement', MEMBER_PROFILE: 'daoships.member.profile',
  PROPOSAL_VOTE_REASON: 'daoships.proposal.vote.reason', NAVIGATOR_ALLOWLIST: 'daoships.navigator.allowlist',
  DAO_NAVIGATORS: 'daoships.dao.navigators', SIGNAL_POLL: 'daoships.signal.poll',
} as const);
export type PosterTag = typeof POSTER_TAGS[keyof typeof POSTER_TAGS];
export const MAX_POSTER_CONTENT_BYTES = 16384;
export interface DaoTheme {
  mode?: 'light' | 'dark'; primary?: string; secondary?: string; accent?: string;
  background?: string; surface?: string; text?: string;
}
export interface DaoProfileMetadata {
  daoAddress: string; name?: string; description?: string; avatar?: string; banner?: string;
  links?: Record<string, string>; tags?: readonly string[]; theme?: DaoTheme; chainId?: number;
}
/** The indexer distinguishes absent fields (keep) from null (clear) for these DAO columns. */
export interface DaoProfileUpdateMetadata extends Omit<DaoProfileMetadata, 'name' | 'description' | 'avatar'> {
  name?: string | null; description?: string | null; avatar?: string | null;
}
export interface PosterPayloads {
  'daoships.dao.profile.initial': DaoProfileMetadata & { name: string; description: string };
  'daoships.dao.profile': DaoProfileUpdateMetadata;
  'daoships.dao.announcement': { daoAddress: string; title: string; body?: string; severity?: 'info' | 'warning' | 'critical'; url?: string; expiresAt?: string };
  'daoships.member.profile': { daoAddress: string; name: string; bio?: string; avatar?: string };
  'daoships.proposal.vote.reason': { daoAddress: string; proposalId?: number; vote?: boolean; reason: string };
  'daoships.navigator.allowlist': { daoAddress: string; navigatorAddress: string; root: string } &
    ({ addresses: readonly string[]; treeDump: AllowlistTreeDump; ipfsCid?: never } | { ipfsCid: string; addresses?: never; treeDump?: never });
  'daoships.dao.navigators': { daoAddress: string; navigators: readonly { address: string; type?: string }[] };
  'daoships.signal.poll': { daoAddress: string; navigatorAddress: string; pollId: bigint | string | number; options: readonly string[]; description?: string; discussionUrl?: string };
}
export interface PosterValidation { valid: boolean; errors: string[] }
const BLOCKED = new Set(['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty']);
const iface = new Interface(CONTRACT_ABIS.Poster);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function clean(value: unknown, depth = 0, budget = { characters: 0, nodes: 0 }): unknown {
  if (depth > 12) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content is too deeply nested.');
  if (++budget.nodes > MAX_POSTER_CONTENT_BYTES) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content has too many values.');
  if (typeof value === 'bigint') {
    if (value < 0n || value >= 2n ** 256n) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster bigint must fit uint256.');
    value = value.toString();
  }
  if (typeof value === 'string') {
    budget.characters += value.length;
    if (budget.characters > MAX_POSTER_CONTENT_BYTES) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content exceeds the character limit.');
    return value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g, '');
  }
  if (Array.isArray(value) || record(value)) {
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster objects must be plain JSON records.');
    const keys = Reflect.ownKeys(value);
    if (keys.length > MAX_POSTER_CONTENT_BYTES || (Array.isArray(value) && value.length > MAX_POSTER_CONTENT_BYTES)) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content has too many entries.');
    const entries: [string, unknown][] = [];
    for (const key of keys) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== 'string' || BLOCKED.has(key) || !('value' in descriptor) || !descriptor.enumerable) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content contains an unsupported property.');
      budget.characters += key.length;
      if (budget.characters > MAX_POSTER_CONTENT_BYTES) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content exceeds the character limit.');
      if (descriptor.value === undefined && !Array.isArray(value)) continue;
      entries.push([key, clean(descriptor.value, depth + 1, budget)]);
    }
    if (Array.isArray(value)) {
      if (entries.length !== value.length || entries.some(([key], i) => key !== String(i))) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster arrays must be dense JSON arrays.');
      return entries.map(([, v]) => v);
    }
    return Object.fromEntries(entries);
  }
  if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  throw new DaoShipsError('INVALID_ARGUMENT', 'Poster content must contain JSON values.');
}
const profileFields = ['daoAddress', 'name', 'description', 'avatar', 'banner', 'links', 'tags', 'theme', 'chainId'];
const fields: Record<PosterTag, readonly string[]> = {
  'daoships.dao.profile.initial': profileFields, 'daoships.dao.profile': profileFields,
  'daoships.dao.announcement': ['daoAddress', 'title', 'body', 'severity', 'url', 'expiresAt'],
  'daoships.member.profile': ['daoAddress', 'name', 'bio', 'avatar'],
  'daoships.proposal.vote.reason': ['daoAddress', 'proposalId', 'vote', 'reason'],
  'daoships.navigator.allowlist': ['daoAddress', 'navigatorAddress', 'root', 'addresses', 'treeDump', 'ipfsCid'],
  'daoships.dao.navigators': ['daoAddress', 'navigators'],
  'daoships.signal.poll': ['daoAddress', 'navigatorAddress', 'pollId', 'options', 'description', 'discussionUrl'],
};
/** Validate complete versioned content against indexer-supported fields without silent truncation. */
export function validatePosterContent(tag: string, content: unknown, options: { signalOptionCount?: number } = {}): PosterValidation {
  const errors: string[] = [];
  if (!Object.hasOwn(fields, tag)) return { valid: false, errors: [`Unknown Poster tag: ${tag}`] };
  if (!record(content)) return { valid: false, errors: ['Content must be a JSON object.'] };
  let p: Record<string, unknown>;
  try {
    p = clean(content) as Record<string, unknown>;
    if (new TextEncoder().encode(JSON.stringify(p)).length > MAX_POSTER_CONTENT_BYTES) return { valid: false, errors: ['Content exceeds the 16384-byte Poster limit.'] };
  } catch { return { valid: false, errors: ['Content cannot be serialized as bounded JSON.'] }; }
  const text = (key: string, max: number, required = false, nullable = false) => {
    const value = p[key];
    if (value === undefined && !required) return;
    if (value === null && nullable) return;
    if (typeof value !== 'string' || !value.trim() || value.length > max) errors.push(`${key} must be a nonempty string of at most ${max} characters.`);
  };
  const addr = (key: string, required = true) => {
    if (p[key] === undefined && !required) return;
    try { address(p[key] as string); } catch { errors.push(`${key} must be a valid address.`); }
  };
  const url = (key: string, nullable = false) => {
    if (p[key] === undefined) return;
    if (p[key] === null && nullable) return;
    text(key, 2048);
    try { const u = new URL(p[key] as string); if (!['http:', 'https:', 'ipfs:'].includes(u.protocol) || !u.host) errors.push(`${key} must be an http, https or ipfs URL.`); }
    catch { errors.push(`${key} must be a valid URL.`); }
  };
  text('schemaVersion', 10, true);
  for (const key of Object.keys(p)) if (key !== 'schemaVersion' && !fields[tag as PosterTag].includes(key)) errors.push(`Unsupported ${tag} field: ${key}.`);
  addr('daoAddress');
  if (tag === POSTER_TAGS.DAO_PROFILE || tag === POSTER_TAGS.DAO_PROFILE_INITIAL) {
    const initial = tag === POSTER_TAGS.DAO_PROFILE_INITIAL;
    text('name', 100, initial, !initial); text('description', 1000, initial, !initial); url('avatar', !initial); url('banner');
    if (p.chainId !== undefined && (!Number.isSafeInteger(p.chainId) || (p.chainId as number) <= 0)) errors.push('chainId must be a positive safe integer.');
    if (p.tags !== undefined && (!Array.isArray(p.tags) || p.tags.length > 20 || p.tags.some(t => typeof t !== 'string' || !t.trim() || t.length > 50))) errors.push('tags must contain at most 20 nonempty strings of at most 50 characters.');
    if (p.links !== undefined) {
      if (!record(p.links) || Object.keys(p.links).length > 20) errors.push('links must be an object with at most 20 entries.');
      else for (const [key, val] of Object.entries(p.links)) {
        try {
          if (!/^[a-zA-Z0-9_-]{1,50}$/.test(key) || BLOCKED.has(key) || typeof val !== 'string' || val.length > 2048) throw new Error('Invalid link');
          const parsed = new URL(val);
          if (!['http:', 'https:', 'ipfs:'].includes(parsed.protocol) || !parsed.host) throw new Error('Invalid link');
        } catch { errors.push(`Invalid link: ${key}.`); }
      }
    }
    if (p.theme !== undefined) {
      if (!record(p.theme)) errors.push('theme must be an object.');
      else for (const [key, val] of Object.entries(p.theme)) {
        if (key === 'mode' ? !['light', 'dark'].includes(val as string) : !['primary', 'secondary', 'accent', 'background', 'surface', 'text'].includes(key) || typeof val !== 'string' || !/^#(?:[a-fA-F0-9]{3}|[a-fA-F0-9]{6})$/.test(val)) errors.push(`Invalid theme token: ${key}.`);
      }
    }
  } else if (tag === POSTER_TAGS.DAO_ANNOUNCEMENT) {
    text('title', 200, true); text('body', 4096); url('url'); text('expiresAt', 30);
    if (p.expiresAt !== undefined && !Number.isFinite(Date.parse(p.expiresAt as string))) errors.push('expiresAt must be a date string.');
    if (p.severity !== undefined && !['info', 'warning', 'critical'].includes(p.severity as string)) errors.push('Invalid announcement severity.');
  } else if (tag === POSTER_TAGS.MEMBER_PROFILE) { text('name', 100, true); text('bio', 1000); url('avatar'); }
  else if (tag === POSTER_TAGS.PROPOSAL_VOTE_REASON) {
    text('reason', 2000, true);
    if (p.proposalId !== undefined && (!Number.isSafeInteger(p.proposalId) || (p.proposalId as number) < 1 || (p.proposalId as number) > 0xffffffff)) errors.push('proposalId must be a uint32 positive integer.');
    if (p.vote !== undefined && typeof p.vote !== 'boolean') errors.push('vote must be boolean.');
  } else if (tag === POSTER_TAGS.NAVIGATOR_ALLOWLIST) {
    addr('navigatorAddress');
    if (typeof p.root !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(p.root) || /^0x0{64}$/.test(p.root)) errors.push('root must be a nonzero bytes32.');
    if (p.ipfsCid !== undefined) {
      if (typeof p.ipfsCid !== 'string' || !/^(Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z2-7]{51,63})$/.test(p.ipfsCid)) errors.push('Invalid IPFS CID.');
      if (p.addresses !== undefined || p.treeDump !== undefined) errors.push('Choose inline allowlist or IPFS CID, not both.');
    } else {
      if (!Array.isArray(p.addresses) || !p.addresses.length || p.addresses.length > 500) errors.push('Inline addresses must contain 1 to 500 members.');
      try {
        validateAllowlistTree(p.treeDump);
        if (!verifyAllowlistRoot(p.treeDump, p.root as string)) errors.push('Allowlist tree root does not match root.');
        const members = new Set(p.treeDump.values.map(v => v.value[0].toLowerCase()));
        if (!Array.isArray(p.addresses) || p.addresses.length !== members.size || p.addresses.some(a => typeof a !== 'string' || !members.delete(a.toLowerCase())) || members.size) errors.push('Inline addresses must exactly match tree members.');
      } catch { errors.push('Invalid allowlist tree dump.'); }
    }
  } else if (tag === POSTER_TAGS.DAO_NAVIGATORS) {
    if (!Array.isArray(p.navigators) || p.navigators.length > 200) errors.push('navigators must contain at most 200 entries ([] clears the sanctioned set).');
    else {
      const seen = new Set<string>();
      for (const nav of p.navigators) {
        if (!record(nav)) { errors.push('Invalid navigator entry.'); continue; }
        for (const key of Object.keys(nav)) if (!['address', 'type'].includes(key)) errors.push(`Unsupported navigator field: ${key}.`);
        try { const a = address(nav.address as string).toLowerCase(); if (seen.has(a)) errors.push('Duplicate sanctioned navigator.'); seen.add(a); } catch { errors.push('Invalid sanctioned navigator address.'); }
        if (nav.type !== undefined && (typeof nav.type !== 'string' || !nav.type.trim() || nav.type.length > 50)) errors.push('Navigator type must be at most 50 characters.');
      }
    }
  } else if (tag === POSTER_TAGS.SIGNAL_POLL) {
    addr('navigatorAddress');
    if (!((typeof p.pollId === 'string' && /^\d+$/.test(p.pollId) && BigInt(p.pollId) < 2n ** 256n) || (typeof p.pollId === 'number' && Number.isSafeInteger(p.pollId) && p.pollId >= 0) || (typeof p.pollId === 'bigint' && p.pollId >= 0n && p.pollId < 2n ** 256n))) errors.push('pollId must be a uint256 exact integer.');
    if (!Array.isArray(p.options) || p.options.length < 2 || p.options.length > 10 || p.options.some(v => typeof v !== 'string' || !v.trim() || v.length > 200)) errors.push('options must contain 2 to 10 ordered, nonempty labels of at most 200 characters.');
    if (options.signalOptionCount !== undefined && (!Array.isArray(p.options) || p.options.length !== options.signalOptionCount)) errors.push('Option label count does not match the on-chain poll.');
    text('description', 1000); url('discussionUrl');
  }
  return { valid: errors.length === 0, errors };
}
/** Inject version, strip control characters and validate before committing metadata on-chain. */
export function buildPosterContent<T extends PosterTag>(tag: T, payload: PosterPayloads[T], options: { schemaVersion?: string; signalOptionCount?: number } = {}): string {
  if (!record(payload)) throw new DaoShipsError('INVALID_ARGUMENT', 'Poster payload must be an object.');
  const data = clean({ ...clean(payload) as Record<string, unknown>, schemaVersion: options.schemaVersion ?? '1.0' });
  const result = validatePosterContent(tag, data, options);
  if (!result.valid) throw new DaoShipsError('INVALID_ARGUMENT', `Invalid ${tag} content.`, { errors: result.errors });
  return JSON.stringify(data);
}
export function encodePosterPost<T extends PosterTag>(poster: string, tag: T, payload: PosterPayloads[T], options: { schemaVersion?: string; signalOptionCount?: number } = {}): { to: Hex; data: Hex; value: bigint; operation: string } {
  return { to: address(poster), data: iface.encodeFunctionData('post(string,string)', [buildPosterContent(tag, payload, options), tag]) as Hex, value: 0n, operation: 'post(string,string)' };
}
/** indexed string tags are stored as keccak256 topics, not recoverable literal strings. */
export function posterTagTopic(tag: string): Hex { return id(tag) as Hex; }
