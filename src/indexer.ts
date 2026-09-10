import { DaoShipsError } from './errors.js';
import { address, proposalId, uint } from './values.js';
import { indexerShapes, indexerRecordOrderingShape, type OrderedRecordRow, type IndexerShape, type IndexerTable, type IndexerTables, type IndexerFilters, type IndexerExpression } from './indexer-models.js';
export * from './indexer-models.js';
export * from './indexer-sync.js';
import { waitForIndexedBlock, type WaitForIndexedBlockOptions } from './indexer-sync.js';

export interface DaoRow {
  id: string; name: string | null; avatar: string; shares_address: string;
  loot_address: string; total_shares: string | null; total_loot: string | null;
}
export interface ProposalRow {
  id: string; dao_id: string; proposal_id: number; details: string | null;
  proposal_data: string | null; proposal_data_hash: string;
  sponsored: boolean | null; processed: boolean | null; passed: boolean | null; action_failed: boolean | null;
  cancelled: boolean | null; yes_balance: string | null; no_balance: string | null;
}
/** Full indexed proposal fields except its potentially large encoded action payload. */
export type ProposalSummary = Omit<IndexerTables['proposals'], 'proposal_data'>;
export interface MemberRow {
  id: string; dao_id: string; member_address: string;
  shares: string | null; loot: string | null; voting_power: string | null;
}
export interface IndexerState {
  chain_id: number; last_block_number: number; last_indexed_at: string | null;
  is_syncing: boolean; requires_full_reindex: boolean;
}
export interface PageOptions { offset?: number; limit?: number; signal?: AbortSignal }
export interface Page<T> {
  items: T[];
  /** Advance by returned rows, including when the server caps a requested page. */
  nextOffset: number | null;
  source: 'indexer';
}
export interface IndexerOptions {
  /** Supabase project URL, without /rest/v1. */
  url: string;
  /** Publishable or anonymous key; never supply a service-role key. */
  key: string;
  schema: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Maximum bytes in a response body, before JSON parsing; defaults to 16 MiB. */
  maxResponseBytes?: number;
}

type Shape = IndexerShape;
export interface IndexerQueryOptions<K extends IndexerTable> extends PageOptions {
  filters?: IndexerFilters<K>;
  where?: readonly IndexerExpression<K>[];
  orderBy?: keyof IndexerTables[K] & string;
  direction?: 'asc' | 'desc';
}
export type IndexerCountOptions<K extends IndexerTable> = Pick<IndexerQueryOptions<K>, 'filters' | 'where' | 'signal'>;
export interface IndexerIterationOptions<K extends IndexerTable> extends IndexerQueryOptions<K> {
  /** Maximum requests, including the final empty page; defaults to 10,000. */
  maxPages?: number;
}
export type NavigatorTrustStatus = 'self_asserted' | 'sanctioned' | 'unsanctioned' | 'fabricated';
const daoShape: Shape = { id: 'string', name: 'string?', avatar: 'string', shares_address: 'string',
  loot_address: 'string', total_shares: 'amount?', total_loot: 'amount?' };
const proposalShape: Shape = { id: 'string', dao_id: 'string', proposal_id: 'integer', details: 'string?',
  proposal_data: 'string?', proposal_data_hash: 'string', sponsored: 'boolean?', processed: 'boolean?',
  passed: 'boolean?', action_failed: 'boolean?', cancelled: 'boolean?', yes_balance: 'amount?', no_balance: 'amount?' };
const memberShape: Shape = { id: 'string', dao_id: 'string', member_address: 'string',
  shares: 'amount?', loot: 'amount?', voting_power: 'amount?' };
const stateShape: Shape = { chain_id: 'integer', last_block_number: 'integer', last_indexed_at: 'string?',
  is_syncing: 'boolean', requires_full_reindex: 'boolean' };

function normalizeRow(row: unknown, shape: Shape): Record<string, unknown> | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const result: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(shape)) {
    if (!Object.hasOwn(row, key)) return null;
    let value = (row as Record<string, unknown>)[key];
    const base = kind.endsWith('?') ? kind.slice(0, -1) : kind;
    if (value === null && kind.endsWith('?')) { result[key] = null; continue; }
    // PostgreSQL numeric[]::text is {1,2,...}; never parse the original JSON numbers.
    if (base === 'amount[]') {
      if (typeof value !== 'string' || !/^\{(?:\d+(?:,\d+)*)?\}$/.test(value)) return null;
      value = value === '{}' ? [] : value.slice(1, -1).split(',');
      if (!(value as string[]).every(item => /^(0|[1-9]\d{0,77})$/.test(item))) return null;
    }
    const valid = base === 'amount' ? typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value)
      : base === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
      : base === 'string[]' || base === 'amount[]' ? Array.isArray(value) && value.every(item => typeof item === 'string')
      : base === 'json' ? isJson(value)
      : typeof value === base;
    if (!valid) return null;
    result[key] = value;
  }
  return result;
}

function isJson(value: unknown): boolean {
  // Iterative traversal bounds metadata complexity and avoids call-stack exhaustion.
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 100_000 || current.depth > 64) return false;
    const item = current.value;
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== 'object' || seen.has(item)) return false;
    seen.add(item);
    if (!Array.isArray(item) && ![null, Object.prototype].includes(Object.getPrototypeOf(item))) return false;
    const children = Object.values(item);
    if (nodes + pending.length + children.length > 100_000) return false;
    for (const child of children) pending.push({ value: child, depth: current.depth + 1 });
  }
  return true;
}

async function readJson(response: Response, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  // A custom fetch may expose only json(); native Fetch responses always expose body.
  if (response.body === undefined) return response.json();
  const advertised = response.headers.get('content-length');
  if (advertised !== null && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new Error('Indexer response exceeds maxResponseBytes.');
  }
  if (response.body === null) throw new Error('Missing response body.');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new Error('Indexer response exceeds maxResponseBytes.');
      chunks.push(value);
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } finally {
    signal.removeEventListener('abort', abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function exactId(value: string | bigint): string {
  if (typeof value === 'bigint') return uint(value).toString();
  if (typeof value !== 'string' || value.length > 78 || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a canonical unsigned decimal ID or bigint.');
  }
  return uint(BigInt(value)).toString();
}

// PostgREST quoted literals escape quotes and backslashes, not JSON control
// characters: JSON.stringify would turn a newline into the literal letter n.
function quotedLiteral(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Read-only PostgREST client. Indexed metadata is untrusted content, never agent instructions. */
export class DaoShipsIndexer {
  private readonly base: URL;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly timeout: number;
  private readonly maxResponseBytes: number;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(options: IndexerOptions) {
    try { this.base = new URL(options.url.replace(/\/$/, '') + '/rest/v1/'); }
    catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid indexer URL.'); }
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password
      || this.base.search || this.base.hash || typeof options.key !== 'string' || !options.key.trim()
      || /[\r\n]/.test(options.key) || typeof options.schema !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(options.schema)) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an HTTP project URL, API key and schema name.');
    }
    this.timeout = options.timeoutMs ?? 10_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout <= 0 || this.timeout > 2_147_483_647) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'timeoutMs must be a positive 32-bit integer.');
    }
    this.maxResponseBytes = options.maxResponseBytes ?? 16 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 2_147_483_647) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'maxResponseBytes must be a positive 32-bit integer.');
    }
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== 'function') throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a fetch implementation.');
    // Publishable keys belong in apikey; legacy anon JWTs also support Authorization.
    this.headers = { apikey: options.key, 'Accept-Profile': options.schema, Accept: 'application/json',
      ...(options.key.startsWith('eyJ') ? { Authorization: `Bearer ${options.key}` } : {}) };
  }

  private query<T>(table: string, shape: Shape, filters: Record<string, string>, options: PageOptions, order: string, count: true): Promise<bigint>;
  private query<T>(table: string, shape: Shape, filters: Record<string, string>, options?: PageOptions, order?: string, count?: false): Promise<Page<T>>;
  private async query<T>(table: string, shape: Shape, filters: Record<string, string>, options: PageOptions = {}, order = 'id.asc', count = false): Promise<Page<T> | bigint> {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(offset + limit)
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'offset must be nonnegative; limit must be 1–1000.');
    }
    const url = new URL(table, this.base);
    // Cast NUMERIC on the server before JSON parsing; even small balances stay strings.
    url.searchParams.set('select', count ? 'id' : Object.entries(shape).map(([k, v]) => v.startsWith('amount') ? `${k}::text` : k).join(','));
    url.searchParams.set('order', order);
    url.searchParams.set('offset', String(offset));
    url.searchParams.set('limit', String(limit));
    for (const [key, value] of Object.entries(filters)) url.searchParams.set(key, value);
    if (url.href.length > 65_536) throw new DaoShipsError('INVALID_ARGUMENT', 'Encoded indexer query exceeds 65536 URL characters.');
    const controller = new AbortController();
    const startedAt = performance.now();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const externalSignal = options.signal;
    const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
    let onAbort: (() => void) | undefined;
    try {
      signal.throwIfAborted();
      const cancelled = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(new Error('Request interrupted.'));
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const request = async (): Promise<Page<T> | bigint> => {
        const response = await this.fetcher(url, { method: count ? 'HEAD' : 'GET', headers: count ? { ...this.headers, Prefer: 'count=exact' } : this.headers, signal, redirect: 'error' });
        if (!response.ok) {
          void response.body?.cancel().catch(() => {});
          throw new DaoShipsError('INDEXER_ERROR', 'Indexer request failed.', { status: response.status, table });
        }
        signal.throwIfAborted();
        if (count) {
          void response.body?.cancel().catch(() => {});
          const range = response.headers.get('content-range');
          const match = range?.match(/^(\*|(0|[1-9]\d{0,77})-(0|[1-9]\d{0,77}))\/(0|[1-9]\d{0,77})$/);
          if (!match) throw new DaoShipsError('INVALID_RESPONSE', 'Indexer did not return an exact Content-Range total.', { table });
          const total = BigInt(match[4]!);
          if (match[1] !== '*' && (BigInt(match[2]!) > BigInt(match[3]!) || BigInt(match[3]!) >= total)) {
            throw new DaoShipsError('INVALID_RESPONSE', 'Indexer returned an inconsistent Content-Range.', { table });
          }
          return total;
        }
        let rows: unknown;
        try { rows = await readJson(response, this.maxResponseBytes, signal); }
        catch (cause) { throw new DaoShipsError('INVALID_RESPONSE', 'Indexer returned invalid or oversized JSON.', { table }, { cause }); }
        signal.throwIfAborted();
        if (!Array.isArray(rows) || rows.length > limit) {
          throw new DaoShipsError('INVALID_RESPONSE', 'Indexer returned an unexpected row shape.', { table });
        }
        const normalized = rows.map(row => normalizeRow(row, shape));
        if (normalized.some(row => row === null)) {
          throw new DaoShipsError('INVALID_RESPONSE', 'Indexer returned an unexpected row shape.', { table });
        }
        // A short response may be the server's own page cap. Only an empty page proves exhaustion.
        return { items: normalized as T[], nextOffset: rows.length ? offset + rows.length : null, source: 'indexer' };
      };
      const result = await Promise.race([request(), cancelled]);
      if (performance.now() - startedAt >= this.timeout) controller.abort();
      signal.throwIfAborted();
      return result;
    } catch (cause) {
      if (externalSignal?.aborted) throw new DaoShipsError('ABORTED', 'Indexer request cancelled.');
      if (controller.signal.aborted) throw new DaoShipsError('TIMEOUT', 'Indexer request timed out.');
      if (cause instanceof DaoShipsError) throw cause;
      throw new DaoShipsError('INDEXER_ERROR', 'Unable to read indexer response.', {}, { cause });
    } finally {
      clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
      controller.abort();
    }
  }

  private buildQuery<K extends IndexerTable>(table: K, options: IndexerQueryOptions<K>) {
    if (!Object.hasOwn(indexerShapes, table)) throw new DaoShipsError('INVALID_ARGUMENT', 'Unknown public indexer table.');
    const shape: Shape = indexerShapes[table];
    const filters: Record<string, string> = {};
    const encodeValue = (key: string, value: unknown): string | null => {
      const kind = shape[key];
      if (!Object.hasOwn(shape, key) || !kind || kind.startsWith('json') || kind.includes('[]')) {
        throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a scalar column filter.', { table, column: key });
      }
      if (value === null && kind.endsWith('?')) return null;
      let normalized: unknown = value;
      if (kind.startsWith('amount')) {
        if (typeof value !== 'bigint' && typeof value !== 'string') {
          throw new DaoShipsError('INVALID_ARGUMENT', 'Numeric filters require decimal strings or bigint.', { column: key });
        }
        const decimal = String(value);
        if (!/^(0|[1-9]\d*)$/.test(decimal) || decimal.length > 78) {
          throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an unsigned decimal with at most 78 digits.', { column: key });
        }
        normalized = decimal;
      }
      const base = kind.replace(/\?$/, '');
      if ((base === 'integer' && !(typeof normalized === 'number' && Number.isSafeInteger(normalized) && normalized >= 0))
        || (base === 'boolean' && typeof normalized !== 'boolean')
        || (base === 'string' && typeof normalized !== 'string')) {
        throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid filter value.', { table, column: key });
      }
      if (typeof normalized === 'string' && normalized.length > 16_384) throw new DaoShipsError('INVALID_ARGUMENT', 'Indexer filter text exceeds 16384 characters.');
      return String(normalized);
    };
    for (const [key, value] of Object.entries(options.filters ?? {})) {
      const encoded = encodeValue(key, value);
      filters[key] = encoded === null ? 'is.null' : `eq.${/[,.:*()"\\\s]/.test(encoded) ? quotedLiteral(encoded) : encoded}`;
    }
    if (options.where !== undefined) {
      if (!Array.isArray(options.where) || options.where.length > 100) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected at most 100 AND conditions.');
      let nodes = 0, values = 0;
      const expression = (condition: IndexerExpression<K>, depth = 0): string => {
        if (++nodes > 100 || depth > 4) throw new DaoShipsError('INVALID_ARGUMENT', 'Indexer conditions exceed 100 nodes or 4 grouping levels.');
        if (!condition || typeof condition !== 'object') throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid indexer condition.');
        if ('all' in condition || 'any' in condition) {
          const key = 'all' in condition ? 'all' : 'any';
          if (Object.keys(condition).length !== 1) throw new DaoShipsError('INVALID_ARGUMENT', 'Expected exactly one AND/OR group key.');
          const members = (condition as { all?: readonly IndexerExpression<K>[]; any?: readonly IndexerExpression<K>[] })[key];
          if (!Array.isArray(members) || !members.length || members.length > 100) throw new DaoShipsError('INVALID_ARGUMENT', 'AND/OR groups require 1–100 conditions.');
          return `${key === 'all' ? 'and' : 'or'}(${Array.from(members, member => expression(member, depth + 1)).join(',')})`;
        }
        const { column, operator, value } = condition;
        if (typeof column !== 'string' || !Object.hasOwn(shape, column) || !['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'ilike', 'is', 'not.is'].includes(operator)) {
          throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid indexer condition column or operator.');
        }
        const path = 'path' in condition ? condition.path : undefined;
        const jsonPath = path !== undefined;
        let selector = String(column);
        if (jsonPath) {
          if (!shape[column]?.startsWith('json') || !Array.isArray(path) || path.length < 1 || path.length > 8
            || Array.from(path).some(part => typeof part !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) {
            throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a JSON column and 1–8 safe identifier path segments.');
          }
          selector += path.map((part, i) => `${i === path.length - 1 ? '->>' : '->'}${part}`).join('');
        }
        if (operator === 'is' || operator === 'not.is') {
          if (value !== null || (!jsonPath && (!shape[column]?.endsWith('?') || shape[column]?.startsWith('json') || shape[column]?.includes('[]')))) {
            throw new DaoShipsError('INVALID_ARGUMENT', 'Null conditions require a nullable scalar column or JSON path.');
          }
          return `${selector}.${operator}.null`;
        }
        if (operator === 'ilike' && ((!jsonPath && !shape[column]?.startsWith('string')) || typeof value !== 'string')) {
          throw new DaoShipsError('INVALID_ARGUMENT', 'ilike requires a text column/path and a string pattern.');
        }
        const literal = (item: unknown) => {
          if (++values > 1000) throw new DaoShipsError('INVALID_ARGUMENT', 'Indexer conditions exceed 1000 scalar values.');
          let encoded: string | null;
          if (jsonPath) {
            if (!(typeof item === 'string' || typeof item === 'boolean' || (typeof item === 'number' && Number.isSafeInteger(item)) || (typeof item === 'bigint' && item >= -(1n << 255n) && item < (1n << 256n)))) {
              throw new DaoShipsError('INVALID_ARGUMENT', 'JSON path filters require text, boolean or exact integer values.');
            }
            encoded = String(item);
            if (encoded.length > 16_384) throw new DaoShipsError('INVALID_ARGUMENT', 'Indexer filter text exceeds 16384 characters.');
          } else encoded = encodeValue(column, item);
          if (encoded === null) throw new DaoShipsError('INVALID_ARGUMENT', 'Use filters for SQL null equality.');
          return quotedLiteral(encoded);
        };
        if (operator === 'in') {
          if (!Array.isArray(value) || value.length === 0 || value.length > 1000) throw new DaoShipsError('INVALID_ARGUMENT', 'An in condition requires 1–1000 scalar values.');
          return `${selector}.in.(${Array.from(value, literal).join(',')})`;
        }
        return `${selector}.${operator}.${literal(value)}`;
      };
      const conditions = Array.from(options.where, condition => expression(condition));
      if (conditions.length) filters.and = `(${conditions.join(',')})`;
    }
    const orderBy = options.orderBy ?? 'id';
    const direction = options.direction ?? 'asc';
    if (!Object.hasOwn(shape, orderBy) || !['asc', 'desc'].includes(direction)) {
      throw new DaoShipsError('INVALID_ARGUMENT', 'Invalid indexer sort column or direction.');
    }
    const order = `${orderBy}.${direction}${orderBy === 'id' ? '' : ',id.asc'}`;
    return { shape, filters, order };
  }

  /** Complete public table projection. SQL BIGINT/NUMERIC columns are exact decimal strings. */
  list<K extends IndexerTable>(table: K, options: IndexerQueryOptions<K> = {}): Promise<Page<IndexerTables[K]>> {
    const { shape, filters, order } = this.buildQuery(table, options);
    return this.query<IndexerTables[K]>(`ds_${table}`, shape, filters, options, order);
  }

  /** Requires the record-ordering migration. Unknown positions sort first within
   * a block so legacy rows cannot be hidden behind confidently ordered rows. */
  listOrderedRecords(options: Omit<IndexerQueryOptions<'records'>, 'orderBy' | 'direction'> = {}): Promise<Page<OrderedRecordRow>> {
    const { shape, filters } = this.buildQuery('records', options);
    return this.query('ds_records', { ...shape, ...indexerRecordOrderingShape }, filters, options,
      'block_number.desc.nullsfirst,transaction_index.desc.nullsfirst,log_index.desc.nullsfirst,id.asc');
  }

  /** Exact filtered total from a HEAD request; counts visible rows under the server's access policy. */
  count<K extends IndexerTable>(table: K, options: IndexerCountOptions<K> = {}): Promise<bigint> {
    const { shape, filters, order } = this.buildQuery(table, options);
    return this.query(`ds_${table}`, shape, filters, { limit: 1, ...(options.signal ? { signal: options.signal } : {}) }, order, true);
  }

  /** Look up a full row by its schema primary key. Composite keys are available on every row's id. */
  async get<K extends IndexerTable>(table: K, id: IndexerTables[K]['id'], signal?: AbortSignal): Promise<IndexerTables[K] | null> {
    const page = await this.list(table, { filters: { id } as unknown as IndexerFilters<K>, limit: 1, ...(signal ? { signal } : {}) });
    return page.items[0] ?? null;
  }

  /** Iterate to an empty page with a request budget and repeated-page detection. */
  async *iterate<K extends IndexerTable>(table: K, options: IndexerIterationOptions<K> = {}): AsyncGenerator<IndexerTables[K]> {
    // Preserve query identity between pages if the caller later edits its options.
    const { signal, ...queryOptions } = options;
    try { options = { ...structuredClone(queryOptions), ...(signal ? { signal } : {}) }; }
    catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Indexer iteration options must contain cloneable query data.'); }
    const maxPages = options.maxPages ?? 10_000;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new DaoShipsError('INVALID_ARGUMENT', 'maxPages must be a positive safe integer.');
    let offset: number | null = options.offset ?? 0;
    let pages = 0;
    let previousIds: string | undefined;
    while (offset !== null) {
      if (pages++ >= maxPages) throw new DaoShipsError('INDEXER_ERROR', 'Indexer iteration exceeded maxPages.', { table, maxPages, offset });
      const page: Page<IndexerTables[K]> = await this.list(table, { ...options, offset });
      const ids = JSON.stringify(page.items.map(item => item.id));
      if (page.items.length && ids === previousIds) throw new DaoShipsError('INVALID_RESPONSE', 'Indexer repeated a page without progress.', { table, offset });
      previousIds = ids;
      for (const item of page.items) {
        if (options.signal?.aborted) throw new DaoShipsError('ABORTED', 'Indexer iteration cancelled.');
        yield item;
      }
      offset = page.nextOffset;
    }
  }

  private forDao<K extends IndexerTable>(table: K, dao: string, options: IndexerQueryOptions<K> = {}) {
    return this.list(table, { ...options, filters: { ...options.filters, dao_id: address(dao).toLowerCase() } as unknown as IndexerFilters<K> });
  }

  listDaos(options?: PageOptions) { return this.query<DaoRow>('ds_daos', daoShape, {}, options); }
  async getDao(dao: string, signal?: AbortSignal): Promise<DaoRow | null> {
    const page = await this.query<DaoRow>('ds_daos', daoShape, { id: `eq.${address(dao).toLowerCase()}` },
      { limit: 1, ...(signal ? { signal } : {}) });
    return page.items[0] ?? null;
  }
  listProposals(dao: string, options?: PageOptions) {
    return this.query<ProposalRow>('ds_proposals', proposalShape, { dao_id: `eq.${address(dao).toLowerCase()}` }, options);
  }
  listProposalSummaries(dao: string, options: IndexerQueryOptions<'proposals'> = {}): Promise<Page<ProposalSummary>> {
    const { shape, filters, order } = this.buildQuery('proposals', { ...options, filters: { ...options.filters, dao_id: address(dao).toLowerCase() } });
    const { proposal_data: _payload, ...summaryShape } = shape;
    return this.query('ds_proposals', summaryShape, filters, options, order);
  }
  async getProposal(dao: string, id: number, signal?: AbortSignal): Promise<ProposalRow | null> {
    const page = await this.query<ProposalRow>('ds_proposals', proposalShape,
      { id: `eq.${address(dao).toLowerCase()}-${proposalId(id)}` }, { limit: 1, ...(signal ? { signal } : {}) });
    return page.items[0] ?? null;
  }
  /** Includes historical members with zero balances. */
  listMembers(dao: string, options?: PageOptions) {
    return this.query<MemberRow>('ds_members', memberShape, { dao_id: `eq.${address(dao).toLowerCase()}` }, options);
  }
  async getState(signal?: AbortSignal): Promise<IndexerState | null> {
    const page = await this.query<IndexerState>('ds_indexer_state', stateShape, { id: 'eq.1' },
      { limit: 1, ...(signal ? { signal } : {}) });
    return page.items[0] ?? null;
  }

  getDaoDetails(dao: string, signal?: AbortSignal) { return this.get('daos', address(dao).toLowerCase(), signal); }
  getProposalDetails(dao: string, id: number, signal?: AbortSignal) { return this.get('proposals', `${address(dao).toLowerCase()}-${proposalId(id)}`, signal); }
  getMember(dao: string, member: string, signal?: AbortSignal) { return this.get('members', `${address(dao).toLowerCase()}-${address(member).toLowerCase()}`, signal); }
  getStateDetails(signal?: AbortSignal) { return this.get('indexer_state', 1, signal); }
  waitForIndexedBlock(targetBlock: bigint, options: WaitForIndexedBlockOptions) { return waitForIndexedBlock(this, targetBlock, options); }
  getNavigator(dao: string, navigator: string, signal?: AbortSignal) {
    return this.get('navigators', `${address(dao).toLowerCase()}-${address(navigator).toLowerCase()}`, signal);
  }
  getVote(dao: string, id: number, voter: string, signal?: AbortSignal) {
    return this.get('votes', `${address(dao).toLowerCase()}-${proposalId(id)}-${address(voter).toLowerCase()}`, signal);
  }
  listSanctionedNavigators(dao: string, options: IndexerQueryOptions<'navigators'> = {}) {
    return this.forDao('navigators', dao, { ...options, filters: { ...options.filters, trust_status: 'sanctioned' } });
  }
  listPollVotes(navigator: string, id: string | bigint, options: IndexerQueryOptions<'signal_votes'> = {}) {
    return this.list('signal_votes', { ...options, filters: { ...options.filters, navigator_address: address(navigator).toLowerCase(), poll_id: exactId(id) } });
  }
  getSignalVote(navigator: string, id: string | bigint, voter: string, signal?: AbortSignal) {
    return this.get('signal_votes', `${address(navigator).toLowerCase()}-${exactId(id)}-${address(voter).toLowerCase()}`, signal);
  }
  getSubscriptionMember(navigator: string, member: string, signal?: AbortSignal) {
    return this.get('subscription_members', `${address(navigator).toLowerCase()}-${address(member).toLowerCase()}`, signal);
  }
  listVotes(dao: string, options?: IndexerQueryOptions<'votes'>) { return this.forDao('votes', dao, options); }
  listNavigators(dao: string, options?: IndexerQueryOptions<'navigators'>) { return this.forDao('navigators', dao, options); }
  listRagequits(dao: string, options?: IndexerQueryOptions<'ragequits'>) { return this.forDao('ragequits', dao, options); }
  listRecords(dao: string, options?: IndexerQueryOptions<'records'>) { return this.forDao('records', dao, options); }
  /** Active membership includes either shares or loot, unlike historical listMembers. */
  listActiveMembers(dao: string, options: IndexerQueryOptions<'members'> = {}) {
    return this.forDao('members', dao, { ...options, where: [...(options.where ?? []), { any: [
      { column: 'shares', operator: 'gt', value: 0n }, { column: 'loot', operator: 'gt', value: 0n },
    ] }] });
  }
  countActiveMembers(dao: string, options: IndexerCountOptions<'members'> = {}) {
    return this.count('members', { ...options, filters: { ...options.filters, dao_id: address(dao).toLowerCase() }, where: [...(options.where ?? []), { any: [
      { column: 'shares', operator: 'gt', value: 0n }, { column: 'loot', operator: 'gt', value: 0n },
    ] }] });
  }
  /** Targeted metadata lookup includes pre-DAO orphan records; validate the returned root against chain state. */
  async getNavigatorAllowlist(dao: string, navigator: string, signal?: AbortSignal): Promise<IndexerTables['records'] | null> {
    const page = await this.list('records', { filters: { tag: 'daoships.navigator.allowlist' }, where: [
      { any: [{ column: 'dao_id', operator: 'eq', value: address(dao).toLowerCase() }, { column: 'dao_id', operator: 'is', value: null }] },
      { column: 'content_json', path: ['navigatorAddress'], operator: 'eq', value: address(navigator).toLowerCase() },
    ], orderBy: 'created_at', direction: 'desc', limit: 1, ...(signal ? { signal } : {}) });
    const item = page.items[0];
    if (!item) return null;
    const metadata = item.content_json;
    if (item.tag !== 'daoships.navigator.allowlist' || (item.dao_id !== null && item.dao_id.toLowerCase() !== address(dao).toLowerCase())
      || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
      || typeof metadata.navigatorAddress !== 'string' || metadata.navigatorAddress.toLowerCase() !== address(navigator).toLowerCase()) {
      throw new DaoShipsError('INVALID_RESPONSE', 'Indexer allowlist record does not match the requested navigator and DAO.');
    }
    return item;
  }
  listGuildTokens(dao: string, options?: IndexerQueryOptions<'guild_tokens'>) { return this.forDao('guild_tokens', dao, options); }
  listEventTransactions(dao: string, options?: IndexerQueryOptions<'event_transactions'>) { return this.forDao('event_transactions', dao, options); }
  listDelegations(dao: string, options?: IndexerQueryOptions<'delegations'>) { return this.forDao('delegations', dao, options); }
  listNavigatorEvents(dao: string, options?: IndexerQueryOptions<'navigator_events'>) { return this.forDao('navigator_events', dao, options); }
  listNftClaims(dao: string, options?: IndexerQueryOptions<'nft_claims'>) { return this.forDao('nft_claims', dao, options); }
  listSignalPolls(dao: string, options?: IndexerQueryOptions<'signal_polls'>) { return this.forDao('signal_polls', dao, options); }
  listSignalVotes(dao: string, options?: IndexerQueryOptions<'signal_votes'>) { return this.forDao('signal_votes', dao, options); }
  listTimelockChanges(dao: string, options?: IndexerQueryOptions<'timelock_changes'>) { return this.forDao('timelock_changes', dao, options); }
  listVestingSchedules(dao: string, options?: IndexerQueryOptions<'vesting_schedules'>) { return this.forDao('vesting_schedules', dao, options); }
  listVestingClaims(dao: string, options?: IndexerQueryOptions<'vesting_claims'>) { return this.forDao('vesting_claims', dao, options); }
  listBudgets(dao: string, options?: IndexerQueryOptions<'budgets'>) { return this.forDao('budgets', dao, options); }
  listBudgetDisbursements(dao: string, options?: IndexerQueryOptions<'budget_disbursements'>) { return this.forDao('budget_disbursements', dao, options); }
  listSubscriptionMembers(dao: string, options?: IndexerQueryOptions<'subscription_members'>) { return this.forDao('subscription_members', dao, options); }
  listSubscriptionPayments(dao: string, options?: IndexerQueryOptions<'subscription_payments'>) { return this.forDao('subscription_payments', dao, options); }
  listSubscriptionCollections(dao: string, options?: IndexerQueryOptions<'subscription_collections'>) { return this.forDao('subscription_collections', dao, options); }
  listVaultModuleEvents(dao: string, options?: IndexerQueryOptions<'vault_module_events'>) { return this.forDao('vault_module_events', dao, options); }
  listGovernanceConfigHistory(dao: string, options?: IndexerQueryOptions<'governance_config_history'>) { return this.forDao('governance_config_history', dao, options); }
  getNftClaim(navigator: string, id: string | bigint, signal?: AbortSignal) { return this.get('nft_claims', `${address(navigator).toLowerCase()}-${exactId(id)}`, signal); }
  getSignalPoll(navigator: string, id: string | bigint, signal?: AbortSignal) { return this.get('signal_polls', `${address(navigator).toLowerCase()}-${exactId(id)}`, signal); }
  getTimelockChange(navigator: string, id: string | bigint, signal?: AbortSignal) { return this.get('timelock_changes', `${address(navigator).toLowerCase()}-${exactId(id)}`, signal); }
  getVestingSchedule(navigator: string, id: string | bigint, signal?: AbortSignal) { return this.get('vesting_schedules', `${address(navigator).toLowerCase()}-${exactId(id)}`, signal); }
  getBudget(navigator: string, id: string | bigint, signal?: AbortSignal) { return this.get('budgets', `${address(navigator).toLowerCase()}-${exactId(id)}`, signal); }
}
