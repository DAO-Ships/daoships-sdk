import { pathToFileURL } from 'node:url';
import { DaoShipsIndexer, indexerShapes, assertIndexerHealthy } from '../dist/indexer.js';
import { DaoShipsData } from '../dist/data-integrations.js';

const ENVIRONMENT = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DAOSHIPS_INDEXER_SCHEMA', 'DAOSHIPS_CHAIN_ID'];
const MAX_REQUESTS = 80, TIMEOUT_MS = 90_000;
function failure(code, stage, reason) { return Object.assign(new Error(`Live indexer acceptance failed (${code}, ${stage}).`), { code, stage, ...(reason ? { reason } : {}) }); }

/** Explicit environment only: no dotenv loading, sibling files or deployment defaults. */
export function liveIndexerConfig(environment) {
  for (const name of ENVIRONMENT) if (typeof environment[name] !== 'string' || !environment[name].trim()) throw failure('MISSING_CONFIGURATION', name);
  const key = environment.SUPABASE_PUBLISHABLE_KEY;
  if (!/^sb_publishable_[A-Za-z0-9_-]{1,256}$/.test(key)) throw failure('INVALID_PUBLISHABLE_KEY', 'configuration');
  let url;
  try { url = new URL(environment.SUPABASE_URL); }
  catch { throw failure('INVALID_URL', 'configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw failure('INVALID_URL', 'configuration');
  const schema = environment.DAOSHIPS_INDEXER_SCHEMA;
  if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(schema)) throw failure('INVALID_SCHEMA', 'configuration');
  const chain = environment.DAOSHIPS_CHAIN_ID;
  if (!/^[1-9]\d{0,15}$/.test(chain) || !Number.isSafeInteger(Number(chain))) throw failure('INVALID_CHAIN_ID', 'configuration');
  const age = environment.DAOSHIPS_INDEXER_MAX_AGE_MS ?? '300000';
  if (typeof age !== 'string' || !/^[1-9]\d{0,15}$/.test(age) || !Number.isSafeInteger(Number(age))) throw failure('INVALID_MAX_AGE', 'configuration');
  return Object.freeze({ url: url.href.replace(/\/$/, ''), key, schema, chainId: Number(chain), maxAgeMs: Number(age) });
}

/** Read-only bounded acceptance. Injectable transport supports offline policy tests. */
export async function testLiveIndexer(environment, fetcher = globalThis.fetch, nowMs = Date.now()) {
  const config = liveIndexerConfig(environment);
  if (typeof fetcher !== 'function') throw failure('INVALID_TRANSPORT', 'configuration');
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw failure('INVALID_CLOCK', 'configuration');
  const base = new URL(`${config.url}/rest/v1/`), tables = Object.keys(indexerShapes);
  const paths = new Set(tables.map(table => new URL(`ds_${table}`, base).href));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS), started = performance.now();
  const health = checkpoint => assertIndexerHealthy(checkpoint, { chainId: config.chainId, maxAgeMs: config.maxAgeMs, nowMs: nowMs + Math.floor(performance.now() - started) });
  let requests = 0, stage = 'checkpoint-before';
  try {
    const indexer = new DaoShipsIndexer({ ...config, timeoutMs: 5_000, maxResponseBytes: 2_000_000,
      fetch: async (input, init) => {
        const url = new URL(String(input)), method = init?.method ?? 'GET';
        const headers = new Headers(init?.headers);
        if (!['GET', 'HEAD'].includes(method) || !paths.has(`${url.origin}${url.pathname}`) || init?.body != null
          || init?.redirect !== 'error' || headers.get('apikey') !== config.key || headers.has('authorization')) throw failure('REQUEST_POLICY', stage);
        if (++requests > MAX_REQUESTS) throw failure('REQUEST_BUDGET', stage);
        controller.signal.throwIfAborted();
        return fetcher(input, init);
      },
    });
    const before = await indexer.getStateDetails(controller.signal);
    const beforeHealth = health(before);
    const samples = new Map(), projections = [];
    stage = 'public-projections';
    for (const table of tables) {
      const [page, count] = await Promise.all([
        indexer.list(table, { limit: 1, signal: controller.signal }),
        indexer.count(table, { signal: controller.signal }),
      ]);
      samples.set(table, page.items[0]);
      projections.push({ table, exactVisibleCount: count.toString(), sampleRows: page.items.length,
        sampleValidation: page.items.length ? 'exercised' : 'unexercised-empty' });
    }
    const data = new DaoShipsData(indexer), joins = {};
    const options = { chainId: config.chainId, signal: controller.signal, timeoutMs: 15_000, maxRows: 3, maxPages: 3, pageSize: 1 };
    const dao = samples.get('daos'), member = samples.get('members'), proposal = samples.get('proposals');
    stage = 'sample-joins';
    if (dao) {
      const result = await data.getDaoProfile(dao.id, options);
      joins.daoProfile = { exercised: true, complete: result.complete, checkpointStable: result.checkpointStable, profilePresent: result.profile !== null, profileAmbiguous: result.profileAmbiguous };
    } else joins.daoProfile = { exercised: false, reason: 'no-sampled-dao' };
    if (member) {
      const result = await data.getMemberProfile(member.dao_id, member.member_address, options);
      joins.memberProfile = { exercised: true, complete: result.complete, checkpointStable: result.checkpointStable, profilePresent: result.profile !== null, profileAmbiguous: result.profileAmbiguous };
    } else joins.memberProfile = { exercised: false, reason: 'no-sampled-member' };
    if (proposal) {
      if (!/^[1-9]\d{0,9}$/.test(proposal.proposal_id) || BigInt(proposal.proposal_id) > 0xffffffffn) throw failure('INVALID_RESPONSE', stage);
      const result = await data.getProposal(proposal.dao_id, Number(proposal.proposal_id), options);
      joins.proposal = { exercised: true, complete: result.complete, checkpointStable: result.checkpointStable, sampledVotes: result.votes.items.length, matchedReasons: result.reasons.length };
    } else joins.proposal = { exercised: false, reason: 'no-sampled-proposal' };
    stage = 'checkpoint-after';
    const after = await indexer.getStateDetails(controller.signal);
    const afterHealth = health(after);
    const unexercisedTables = projections.filter(item => !item.sampleRows).map(item => item.table);
    return { status: 'read-only-checks-passed', chainId: config.chainId, requests, maxRequests: MAX_REQUESTS,
      projections, joins, unexercisedTables,
      checkpoints: { maxAgeMs: config.maxAgeMs, before: { lastIndexedAt: before.last_indexed_at, ageMs: beforeHealth.ageMs }, after: { lastIndexedAt: after.last_indexed_at, ageMs: afterHealth.ageMs } },
      checkpointStable: before.last_block_number === after.last_block_number && before.last_block_hash !== null && before.last_block_hash === after.last_block_hash,
      limitations: ['Sampled reads are not complete feature coverage.', 'Empty tables do not exercise row validation.', 'Counts and joined reads are non-atomic indexer claims.', 'No write, transaction, realtime or IPFS acceptance was performed.'] };
  } catch (cause) {
    const code = controller.signal.aborted ? 'TIMEOUT' : /^[A-Z_]{1,50}$/.test(cause?.code) ? cause.code : 'LIVE_READ_FAILED';
    const reason = ['STALE', 'REINDEX_REQUIRED', 'NOT_INITIALIZED', 'BEHIND'].includes(cause?.details?.reason) ? cause.details.reason : undefined;
    throw failure(code, stage, reason);
  } finally { clearTimeout(timer); controller.abort(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await testLiveIndexer(process.env), null, 2)); }
  catch (error) {
    // Never print raw transport errors, request URLs, keys or indexed content.
    console.error(JSON.stringify({ status: 'failed', code: error.code, stage: error.stage, ...(error.reason ? { reason: error.reason } : {}) }));
    process.exitCode = 1;
  }
}
