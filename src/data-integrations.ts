import { DaoShipsError } from './errors.js';
import { address, proposalId, type Hex } from './values.js';
import { validateAllowlistTree, getAllowlistProof, verifyAllowlistProof, type AllowlistTreeDump } from './allowlist.js';
import { DaoShipsIndexer, indexerShapes, type OrderedRecordRow, type IndexerFilters, type IndexerQueryOptions, type IndexerTables, type IndexerTable, type IndexerStateDetails } from './indexer.js';
import { assertIndexerHealthy } from './indexer-sync.js';
import { POSTER_TAGS, validatePosterContent } from './poster.js';
import type { DaoProfileState } from './profile.js';

import { bounded, positive, streamedJson, type DataReadOptions } from './data-transport.js';
export type { DataReadOptions } from './data-transport.js';
import { validateAllowlistCid } from './ipfs-cid.js';
export { validateAllowlistCid } from './ipfs-cid.js';
import { resolveIpfsUrl } from './ipfs.js';

function root(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value) || /^0x0{64}$/.test(value)) throw new DaoShipsError('INVALID_RESPONSE', 'Expected a nonzero on-chain allowlist root.');
  return value.toLowerCase() as Hex;
}
export interface FetchIpfsAllowlistOptions extends DataReadOptions {
  cid: string;
  /** HTTP(S) gateway origin/prefix, optionally ending in /ipfs/. Redirects are rejected. */
  gateway?: string;
  account: string;
  /** Caller-owned chain read of the intended navigator's allowlistRoot, invoked before and after fetching. */
  readRoot: (signal: AbortSignal) => Promise<string>;
  /** Optional metadata root; must also match the caller's chain read. */
  expectedRoot?: string;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
}
export interface VerifiedIpfsAllowlist { cid: string; root: Hex; tree: AllowlistTreeDump; account: Hex; proof: Hex[] | null; member: boolean; verifiedAgainst: 'caller-chain-root' }
export async function fetchIpfsAllowlist(options: FetchIpfsAllowlistOptions): Promise<VerifiedIpfsAllowlist> {
  const cid = validateAllowlistCid(options.cid), account = address(options.account);
  const maxBytes = positive(options.maxBytes ?? 2_000_000, 'maxBytes', 16_777_216);
  const fetcher = options.fetch ?? globalThis.fetch, readRoot = options.readRoot;
  if (typeof fetcher !== 'function' || typeof readRoot !== 'function') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected fetch and an on-chain root reader.');
  const gateway = new URL(resolveIpfsUrl(cid, 'content', options.gateway));
  const expected = options.expectedRoot === undefined ? undefined : root(options.expectedRoot);
  return bounded(async signal => {
    const before = root(await readRoot(signal));
    if (expected !== undefined && before !== expected) throw new DaoShipsError('HASH_MISMATCH', 'Metadata allowlist root differs from the on-chain root.');
    const document = await streamedJson(await fetcher(gateway, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'error', signal }), maxBytes, signal);
    const candidate = document && typeof document === 'object' && Object.hasOwn(document, 'treeDump') ? (document as { treeDump: unknown }).treeDump : document;
    try { validateAllowlistTree(candidate); }
    catch (cause) { throw new DaoShipsError('INVALID_RESPONSE', 'IPFS allowlist tree is invalid.', {}, { cause }); }
    if (candidate.tree[0]!.toLowerCase() !== before) throw new DaoShipsError('HASH_MISMATCH', 'IPFS allowlist does not match the on-chain root.');
    const proof = getAllowlistProof(candidate, account);
    if (proof !== null && !verifyAllowlistProof(before, account, proof)) throw new DaoShipsError('HASH_MISMATCH', 'Allowlist proof verification failed.');
    const after = root(await readRoot(signal));
    if (after !== before) throw new DaoShipsError('PLAN_CHANGED', 'On-chain allowlist root changed during retrieval.');
    return { cid, root: before, tree: candidate, account, proof, member: proof !== null, verifiedAgainst: 'caller-chain-root' };
  }, options);
}

export interface AllowlistPinDocument { content: Uint8Array; filename: 'allowlist.json'; contentType: 'application/json' }
export interface PublishAllowlistOptions extends DataReadOptions {
  /** Caller-owned storage/pinning operation. The SDK supplies canonical JSON bytes. */
  pin: (document: AllowlistPinDocument, signal: AbortSignal) => Promise<string | { cid: string }>;
  maxBytes?: number;
}
/** Validates and uploads a tree through the caller's adapter; a returned CID is not a retrieval/root attestation. */
export async function publishAllowlist(tree: AllowlistTreeDump, options: PublishAllowlistOptions) {
  const maxBytes = positive(options.maxBytes ?? 2_000_000, 'maxBytes', 16_777_216), pin = options.pin;
  if (typeof pin !== 'function') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an allowlist pinning adapter.');
  validateAllowlistTree(tree);
  const canonical: AllowlistTreeDump = { format: 'standard-v1', leafEncoding: ['address'], tree: tree.tree.map(value => value.toLowerCase()), values: tree.values.map(entry => ({ value: [address(entry.value[0]).toLowerCase()], treeIndex: entry.treeIndex })) };
  const content = new TextEncoder().encode(JSON.stringify(canonical));
  if (content.byteLength > maxBytes) throw new DaoShipsError('INVALID_ARGUMENT', 'Allowlist upload exceeds maxBytes.');
  return bounded(async signal => {
    const result = await pin({ content, filename: 'allowlist.json', contentType: 'application/json' }, signal);
    let cid: string;
    try { cid = validateAllowlistCid(typeof result === 'string' ? result : result?.cid); }
    catch (cause) { throw new DaoShipsError('INVALID_RESPONSE', 'Pinning adapter returned an unsupported CID.', {}, { cause }); }
    return { cid, root: canonical.tree[0] as Hex, bytes: content.byteLength, memberCount: canonical.values.length, verification: 'local-tree-only' as const, storageVerification: 'adapter-reported-cid' as const };
  }, options);
}

export interface BoundedTableOptions extends DataReadOptions { maxRows?: number; maxPages?: number; pageSize?: number }
export interface TableSnapshot<T> { items: T[]; complete: boolean; reason: 'exhausted' | 'row_limit' | 'page_limit'; pages: number; atomic: false }
function limits(options: BoundedTableOptions) {
  return { maxRows: positive(options.maxRows ?? 2000, 'maxRows', 100_000), maxPages: positive(options.maxPages ?? 50, 'maxPages', 1000), pageSize: positive(options.pageSize ?? 100, 'pageSize', 1000) };
}
async function tableSnapshot<K extends IndexerTable>(indexer: DaoShipsIndexer, table: K, query: IndexerQueryOptions<K>, options: BoundedTableOptions, signal: AbortSignal): Promise<TableSnapshot<IndexerTables[K]>> {
  const { maxRows, maxPages, pageSize } = limits(options), items: IndexerTables[K][] = [];
  let offset = query.offset ?? 0, previous: string | undefined;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await indexer.list(table, { ...query, offset, limit: Math.min(pageSize, maxRows - items.length), signal });
    if (!page.items.length) return { items, complete: true, reason: 'exhausted', pages, atomic: false };
    const ids = JSON.stringify(page.items.map(item => item.id));
    if (ids === previous) throw new DaoShipsError('INVALID_RESPONSE', 'Indexer repeated a page during joined/refreshed reads.');
    previous = ids; items.push(...page.items); offset += page.items.length;
    if (items.length >= maxRows) return { items, complete: false, reason: 'row_limit', pages, atomic: false };
  }
  return { items, complete: false, reason: 'page_limit', pages: maxPages, atomic: false };
}
export interface JoinedReadOptions extends BoundedTableOptions { chainId: number }
export interface JoinCheckpoint { before: IndexerStateDetails; after: IndexerStateDetails; checkpointStable: boolean; atomic: false; source: 'indexer'; trust: 'indexer-claims-only' }
async function checkpoint(indexer: DaoShipsIndexer, chainId: number, signal: AbortSignal) {
  const value = await indexer.getStateDetails(signal); assertIndexerHealthy(value, { chainId });
  if (value!.last_block_hash !== null && !/^0x[0-9a-fA-F]{64}$/.test(value!.last_block_hash)) throw new DaoShipsError('INVALID_RESPONSE', 'Indexer checkpoint contains an invalid block hash.');
  return value!;
}
function joinCheckpoint(before: IndexerStateDetails, after: IndexerStateDetails): JoinCheckpoint {
  return { before, after, checkpointStable: before.last_block_number === after.last_block_number && before.last_block_hash !== null && before.last_block_hash.toLowerCase() === after.last_block_hash?.toLowerCase(), atomic: false, source: 'indexer', trust: 'indexer-claims-only' };
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function sameAddress(value: unknown, expected: string) { return typeof value === 'string' && value.toLowerCase() === expected.toLowerCase(); }
function latestProfile(records: readonly (IndexerTables['records'] | OrderedRecordRow)[], ordered: boolean) {
  // Baseline projections omit additive ordering columns. The deterministic ID
  // tie-breaker is a hash; only opted-in event positions can establish order.
  const [first, second] = records;
  const position = (row: IndexerTables['records'] | OrderedRecordRow) => {
    const candidate = row as Partial<OrderedRecordRow>;
    return typeof candidate.transaction_index === 'number' && typeof candidate.log_index === 'number' ? [candidate.transaction_index, candidate.log_index] : null;
  };
  const a = first && ordered ? position(first) : null, b = second && ordered ? position(second) : null;
  const sameBlockOrdered = a !== null && b !== null && (a[0]! > b[0]! || (a[0] === b[0] && a[1]! > b[1]!));
  const ambiguous = !!first && !!second && (first.block_number === null || second.block_number === null || (first.block_number === second.block_number && !sameBlockOrdered));
  return { profile: ambiguous ? null : first ?? null, profileAmbiguous: ambiguous,
    profileReason: ambiguous ? 'ambiguous-record-order' as const : first ? 'latest-record' as const : 'no-record' as const };
}
/** Cross-table reads remain explicitly non-atomic, with before/after checkpoint observations. */
export class DaoShipsData {
  private readonly recordOrdering: boolean;
  constructor(private readonly indexer: DaoShipsIndexer, options: { recordOrdering?: boolean } = {}) {
    if (options.recordOrdering !== undefined && typeof options.recordOrdering !== 'boolean') throw new DaoShipsError('INVALID_ARGUMENT', 'recordOrdering must be boolean.');
    this.recordOrdering = options.recordOrdering ?? false;
  }
  private async profileRecords(query: IndexerQueryOptions<'records'>, signal: AbortSignal) {
    if (!this.recordOrdering) return (await tableSnapshot(this.indexer, 'records', query, { maxRows: 2, maxPages: 2, pageSize: 2 }, signal)).items;
    const first = await this.indexer.listOrderedRecords({ ...query, limit: 2, signal });
    if (first.items.length !== 1) return first.items;
    const second = await this.indexer.listOrderedRecords({ ...query, offset: 1, limit: 1, signal });
    if (second.items[0]?.id === first.items[0]!.id) throw new DaoShipsError('INVALID_RESPONSE', 'Indexer repeated an ordered profile record.');
    return [...first.items, ...second.items];
  }
  async getDaoProfile(daoAddress: string, options: JoinedReadOptions) {
    const dao = address(daoAddress).toLowerCase(), settings = { ...options }; limits(settings);
    return bounded(async signal => {
      const before = await checkpoint(this.indexer, settings.chainId, signal);
      const details = await this.indexer.getDaoDetails(dao, signal);
      if (details && !sameAddress(details.id, dao)) throw new DaoShipsError('INVALID_RESPONSE', 'DAO details do not match requested identity.');
      // Record-only governance updates (banner/theme/etc.) need not update
      // profile_source: that flag changes only when materialized columns change.
      const eligibleTags = details?.profile_source === 'vault' ? [POSTER_TAGS.DAO_PROFILE] : [POSTER_TAGS.DAO_PROFILE, POSTER_TAGS.DAO_PROFILE_INITIAL];
      const records = details ? await this.profileRecords({ filters: { dao_id: dao }, where: [{ column: 'tag', operator: 'in', value: eligibleTags }, { column: 'trust_level', operator: 'in', value: ['VERIFIED_INITIAL', 'VERIFIED'] }], orderBy: 'block_number', direction: 'desc' }, signal) : [];
      const latest = latestProfile(records, this.recordOrdering), { profile } = latest;
      const metadata: DaoProfileState = {};
      if (details) { metadata.name = details.name; metadata.description = details.description; metadata.avatar = details.avatar_img; }
      if (profile) {
        const content = profile.content_json, tag = profile.tag;
        const authorValid = sameAddress(profile.user_address, details!.avatar) || sameAddress(profile.user_address, dao) || (tag === POSTER_TAGS.DAO_PROFILE_INITIAL && sameAddress(profile.user_address, details!.deployer ?? ''));
        const trusted = tag === POSTER_TAGS.DAO_PROFILE ? profile.trust_level === 'VERIFIED' : ['VERIFIED_INITIAL', 'VERIFIED'].includes(profile.trust_level ?? '');
        if (!trusted || !eligibleTags.includes(tag as typeof eligibleTags[number]) || !sameAddress(profile.dao_id, dao) || !object(content) || !sameAddress(content.daoAddress, dao) || !authorValid || !validatePosterContent(tag, content).valid) throw new DaoShipsError('INVALID_RESPONSE', 'Profile record failed indexed identity/schema cross-checks.');
        for (const key of ['banner', 'links', 'tags', 'theme', 'chainId'] as const) if (Object.hasOwn(content, key)) (metadata as Record<string, unknown>)[key] = content[key];
      }
      const after = await checkpoint(this.indexer, settings.chainId, signal);
      return { dao: details, ...latest, metadata, complete: !latest.profileAmbiguous && details !== null && (details.profile_source === null || profile !== null), ...joinCheckpoint(before, after) };
    }, settings);
  }
  async getMemberProfile(daoAddress: string, memberAddress: string, options: JoinedReadOptions) {
    const dao = address(daoAddress).toLowerCase(), member = address(memberAddress).toLowerCase(), settings = { ...options }; limits(settings);
    return bounded(async signal => {
      const before = await checkpoint(this.indexer, settings.chainId, signal);
      const [membership, records] = await Promise.all([this.indexer.getMember(dao, member, signal), this.profileRecords({ filters: { dao_id: dao, user_address: member, tag: POSTER_TAGS.MEMBER_PROFILE }, orderBy: 'block_number', direction: 'desc' }, signal)]);
      if (membership && (membership.id !== `${dao}-${member}` || !sameAddress(membership.dao_id, dao) || !sameAddress(membership.member_address, member))) throw new DaoShipsError('INVALID_RESPONSE', 'Membership identity mismatch.');
      const latest = latestProfile(records, this.recordOrdering), { profile } = latest;
      if (profile && (!['MEMBER', 'VERIFIED', 'VERIFIED_INITIAL', 'SEMI_TRUSTED', 'ON_CHAIN_PROVISIONAL'].includes(profile.trust_level ?? '') || !sameAddress(profile.dao_id, dao) || !sameAddress(profile.user_address, member) || profile.tag !== POSTER_TAGS.MEMBER_PROFILE || !object(profile.content_json) || !sameAddress(profile.content_json.daoAddress, dao) || !validatePosterContent(POSTER_TAGS.MEMBER_PROFILE, profile.content_json).valid)) throw new DaoShipsError('INVALID_RESPONSE', 'Member profile failed indexed identity/schema cross-checks.');
      const after = await checkpoint(this.indexer, settings.chainId, signal);
      return { member: membership, ...latest, complete: !latest.profileAmbiguous, ...joinCheckpoint(before, after) };
    }, settings);
  }
  async getProposal(daoAddress: string, id: number, options: JoinedReadOptions) {
    const dao = address(daoAddress).toLowerCase(), number = proposalId(id), key = `${dao}-${number}`, settings = { ...options }; limits(settings);
    return bounded(async signal => {
      const before = await checkpoint(this.indexer, settings.chainId, signal);
      const [proposal, votes, records] = await Promise.all([
        this.indexer.getProposalDetails(dao, number, signal),
        tableSnapshot(this.indexer, 'votes', { filters: { dao_id: dao, proposal_id: key } }, settings, signal),
        tableSnapshot(this.indexer, 'records', { filters: { dao_id: dao, tag: POSTER_TAGS.PROPOSAL_VOTE_REASON }, where: [{ column: 'content_json', path: ['proposalId'], operator: 'eq', value: number }, { column: 'trust_level', operator: 'in', value: ['MEMBER', 'VERIFIED', 'VERIFIED_INITIAL'] }], orderBy: 'created_at', direction: 'desc' }, settings, signal),
      ]);
      if (proposal && (proposal.id !== key || !sameAddress(proposal.dao_id, dao) || proposal.proposal_id !== String(number))) throw new DaoShipsError('INVALID_RESPONSE', 'Proposal identity mismatch.');
      const voters = new Map<string, IndexerTables['votes']>();
      for (const vote of votes.items) {
        const voter = address(vote.voter).toLowerCase();
        if (!sameAddress(vote.dao_id, dao) || vote.proposal_id !== key || vote.id !== `${key}-${voter}` || voters.has(voter)) throw new DaoShipsError('INVALID_RESPONSE', 'Vote identity mismatch or duplicate voter.');
        voters.set(voter, vote);
      }
      const reasons = records.items.filter(record => {
        const content = record.content_json, vote = voters.get(record.user_address.toLowerCase());
        return !!vote && sameAddress(record.dao_id, dao) && record.tag === POSTER_TAGS.PROPOSAL_VOTE_REASON && ['MEMBER', 'VERIFIED', 'VERIFIED_INITIAL'].includes(record.trust_level ?? '') && object(content) && sameAddress(content.daoAddress, dao) && content.proposalId === number && (content.vote === undefined || content.vote === vote.approved) && validatePosterContent(POSTER_TAGS.PROPOSAL_VOTE_REASON, content).valid;
      });
      const after = await checkpoint(this.indexer, settings.chainId, signal);
      return { proposal, votes, reasons, reasonRecords: records, reasonVerification: 'matched-indexed-vote-and-poster-schema' as const, excludedReasonCount: records.items.length - reasons.length, complete: votes.complete && records.complete, ...joinCheckpoint(before, after) };
    }, settings);
  }
}

/** Supabase-compatible row-change envelope. Row payloads are deliberately never trusted/applied. */
export interface RealtimeChange { schema: string; table: string; eventType: 'INSERT' | 'UPDATE' | 'DELETE'; new?: unknown; old?: unknown }
export interface RealtimeCallbacks { onChange: (event: unknown) => void; onReconnect: () => void; onReorg: () => void; onError: (cause: unknown) => void }
export type RealtimeSubscribe = (callbacks: RealtimeCallbacks, signal: AbortSignal) => (() => void | Promise<void>) | Promise<() => void | Promise<void>>;
export interface SupabaseRealtimeChannel {
  on(type: 'postgres_changes', filter: { event: '*'; schema: string; table: string; filter?: string }, callback: (event: unknown) => void): SupabaseRealtimeChannel;
  subscribe(callback: (status: string, error?: Error) => void): SupabaseRealtimeChannel;
}
export interface SupabaseRealtimeClient {
  channel(name: string): SupabaseRealtimeChannel;
  removeChannel(channel: SupabaseRealtimeChannel): unknown | Promise<unknown>;
}
export interface SupabaseRealtimeOptions<K extends IndexerTable> {
  schema: string;
  table: K;
  channelName?: string;
  /** Optional single scalar equality filter; complex filters stay in watchIndexer.query. */
  filter?: { column: keyof IndexerFilters<K> & string; value: string | bigint | number | boolean };
}
let channelSequence = 0;
/** Structural Supabase bridge: no Supabase package import or hard runtime dependency. */
export function supabaseRealtimeAdapter<K extends IndexerTable>(client: SupabaseRealtimeClient, options: SupabaseRealtimeOptions<K>): RealtimeSubscribe {
  const { schema, table } = options;
  if (!client || typeof client.channel !== 'function' || typeof client.removeChannel !== 'function' || typeof schema !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(schema) || !Object.hasOwn(indexerShapes, table)) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a Supabase-compatible client, schema and public table.');
  const channelName = options.channelName ?? `daoships-${table}-${++channelSequence}`;
  if (!/^[a-zA-Z0-9:_-]{1,128}$/.test(channelName)) throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid realtime channel name.');
  let filter: string | undefined;
  if (options.filter) {
    const { column, value } = options.filter;
    const shape = indexerShapes[table] as Readonly<Record<string, string>>, kind = shape[column];
    if (!Object.hasOwn(shape, column) || !kind || kind.startsWith('json') || kind.includes('[]')) throw new DaoShipsError('INVALID_ARGUMENT', 'Realtime equality filters require a scalar column.');
    const base = kind.replace(/\?$/, ''), encoded = String(value);
    if ((base === 'string' && typeof value !== 'string') || (base === 'boolean' && typeof value !== 'boolean')
      || (base === 'integer' && !(typeof value === 'number' && Number.isSafeInteger(value) && value >= 0))
      || (base === 'amount' && !((typeof value === 'bigint' || typeof value === 'string') && /^(0|[1-9]\d{0,77})$/.test(encoded)))
      || !/^[a-zA-Z0-9_:.@-]{1,256}$/.test(encoded)) throw new DaoShipsError('INVALID_ARGUMENT', 'Realtime filter requires an exact scalar without query syntax.');
    filter = `${column}=eq.${encoded}`;
  }
  return (callbacks, signal) => {
    if (signal.aborted) throw new DaoShipsError('ABORTED', 'Realtime subscription cancelled.');
    const channel = client.channel(channelName);
    let closing = false, removed: Promise<void> | undefined;
    const release = () => {
      if (removed) return removed;
      closing = true; signal.removeEventListener('abort', abort);
      removed = Promise.resolve().then(() => client.removeChannel(channel)).then(result => {
        if (result === 'error' || result === 'timed out') throw new DaoShipsError('INDEXER_ERROR', 'Supabase channel removal failed.', { status: result });
      });
      return removed;
    };
    const abort = () => { void release().catch(callbacks.onError); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      channel.on('postgres_changes', { event: '*', schema, table: `ds_${table}`, ...(filter ? { filter } : {}) }, event => { if (!closing) callbacks.onChange(event); })
        .subscribe((status, error) => {
          if (closing) return;
          if (status === 'SUBSCRIBED') callbacks.onReconnect();
          else if (['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED'].includes(status)) callbacks.onError(new DaoShipsError('INDEXER_ERROR', 'Supabase realtime connection requires reconciliation.', { status }, error ? { cause: error } : undefined));
        });
      return release;
    } catch (cause) { void release().catch(callbacks.onError); throw cause; }
  };
}
export interface WatchIndexerOptions<K extends IndexerTable> extends BoundedTableOptions {
  schema: string;
  query?: Omit<IndexerQueryOptions<K>, 'signal' | 'offset' | 'limit'>;
  subscribe: RealtimeSubscribe;
  onSnapshot: (snapshot: RealtimeSnapshot<IndexerTables[K]>) => void | Promise<void>;
  onError?: (error: DaoShipsError) => void;
  /** Coalesces bursts into one pending invalidation; minimum 10 ms, default 100 ms. */
  debounceMs?: number;
}
export interface RealtimeSnapshot<T> extends TableSnapshot<T> { revision: number; invalidatedDuringRead: boolean; consistency: 'eventually-consistent' }
export interface IndexerWatch<T> { readonly snapshot: RealtimeSnapshot<T>; readonly lastError: DaoShipsError | null; refresh(): Promise<RealtimeSnapshot<T>>; close(): Promise<void> }
/** Refetch on changes/reconnect/reorg: raw realtime numeric values never bypass PostgREST text casts. */
export async function watchIndexer<K extends IndexerTable>(indexer: DaoShipsIndexer, table: K, options: WatchIndexerOptions<K>): Promise<IndexerWatch<IndexerTables[K]>> {
  const settings = { ...options }, budget = limits(settings), debounceMs = positive(settings.debounceMs ?? 100, 'debounceMs');
  if (debounceMs < 10 || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(settings.schema) || typeof settings.subscribe !== 'function' || typeof settings.onSnapshot !== 'function') throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid realtime subscription/schema/debounce options.');
  let query: WatchIndexerOptions<K>['query'];
  try { query = structuredClone(settings.query ?? {}); }
  catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Realtime query must be cloneable data.'); }
  const controller = new AbortController(), signal = settings.signal ? AbortSignal.any([settings.signal, controller.signal]) : controller.signal;
  let closed = false, dirty = false, revision = 0, timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot: RealtimeSnapshot<IndexerTables[K]> | undefined, lastError: DaoShipsError | null = null;
  let pending: Promise<RealtimeSnapshot<IndexerTables[K]>> | undefined, cleanup: (() => void | Promise<void>) | undefined;
  let closing: Promise<void> | undefined, delivering = false;
  const report = (cause: unknown) => {
    if (closed) return;
    lastError = cause instanceof DaoShipsError ? cause : new DaoShipsError('INDEXER_ERROR', 'Realtime transport/refetch failed.', {}, { cause });
    try { settings.onError?.(lastError); } catch { /* Observer errors cannot strand cleanup. */ }
  };
  const close = async () => {
    if (closed) return closing;
    closed = true; controller.abort(); signal.removeEventListener('abort', aborted); if (timer) clearTimeout(timer);
    const release = cleanup; cleanup = undefined;
    closing = release ? bounded(async () => { await release(); }, { timeoutMs: settings.timeoutMs ?? 30_000 }) : Promise.resolve();
    await closing;
  };
  const aborted = () => { void close().catch(report); };
  signal.addEventListener('abort', aborted, { once: true });
  const schedule = () => {
    if (closed || pending || timer) return;
    timer = setTimeout(() => { timer = undefined; void refresh().catch(() => {}); }, debounceMs);
  };
  const invalidate = () => { if (closed) return; dirty = true; revision = revision === Number.MAX_SAFE_INTEGER ? 0 : revision + 1; schedule(); };
  const refresh = (): Promise<RealtimeSnapshot<IndexerTables[K]>> => {
    if (closed || signal.aborted) return Promise.reject(new DaoShipsError('ABORTED', 'Indexer watch is closed.'));
    if (pending) return pending;
    if (timer) { clearTimeout(timer); timer = undefined; }
    dirty = false;
    pending = bounded(async readSignal => {
      const rows = await tableSnapshot(indexer, table, query ?? {}, budget, readSignal);
      const result: RealtimeSnapshot<IndexerTables[K]> = { ...rows, revision, invalidatedDuringRead: dirty, consistency: 'eventually-consistent' };
      readSignal.throwIfAborted(); snapshot = result; lastError = null;
      delivering = true;
      try { await settings.onSnapshot(result); }
      finally { delivering = false; }
      return result;
    }, { signal, timeoutMs: settings.timeoutMs ?? 30_000 }).catch(cause => {
      report(cause);
      // A timed-out observer may still be running: stop the watch so further
      // invalidations cannot accumulate overlapping asynchronous callbacks.
      if (delivering) void close().catch(() => {});
      throw cause;
    }).finally(() => { pending = undefined; if (dirty && !closed) schedule(); });
    return pending;
  };
  try {
    await bounded(async subscribeSignal => {
      const release = await settings.subscribe({
        onChange(event) {
          if (closed) return;
          if (!object(event) || event.schema !== settings.schema || event.table !== `ds_${table}` || !['INSERT', 'UPDATE', 'DELETE'].includes(event.eventType as string)) { report(new DaoShipsError('INVALID_RESPONSE', 'Unexpected realtime change envelope.')); return; }
          invalidate();
        },
        onReconnect: invalidate, onReorg: invalidate, onError: report,
      }, signal);
      if (typeof release !== 'function') throw new DaoShipsError('INVALID_RESPONSE', 'Realtime subscribe must return an unsubscribe function.');
      if (closed || signal.aborted || subscribeSignal.aborted) { await release(); return; }
      cleanup = release;
    }, { signal, timeoutMs: settings.timeoutMs ?? 30_000 });
    await refresh();
    return { get snapshot() { return snapshot!; }, get lastError() { return lastError; }, refresh, close };
  } catch (cause) { await close(); throw cause; }
}
