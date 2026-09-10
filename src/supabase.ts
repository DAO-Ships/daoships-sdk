import { DaoShipsIndexer, assertIndexerHealthy, type IndexerOptions, type IndexerHealthOptions } from './indexer.js';
import { DaoShipsData } from './data-integrations.js';
import { DaoShipsError } from './errors.js';

/** Public read connection supplied by DAOShips. No privileged credential is bundled. */
export const DAOSHIPS_SUPABASE = Object.freeze({
  url: 'https://anpmmwvxzchumfclhvmr.supabase.co',
  publishableKey: 'sb_publishable_T8AhKZG46_1IdfGGT5y4zg_cNnXIpWN',
});

export const DAOSHIPS_INDEXER_NETWORKS = Object.freeze({
  mainnet: Object.freeze({ chainId: 9, schema: 'mainnet' }),
  testnet: Object.freeze({ chainId: 15000, schema: 'testnet' }),
});
export type DaoShipsIndexerNetwork = keyof typeof DAOSHIPS_INDEXER_NETWORKS;

export interface DaoShipsSupabaseOptions extends Pick<IndexerOptions, 'fetch' | 'timeoutMs' | 'maxResponseBytes'> {
  /** Always explicit: the SDK never silently selects a network. */
  network: DaoShipsIndexerNetwork;
  /** Override the hosted project. A custom URL requires an explicit publishableKey. */
  url?: string;
  /** Defaults to the bundled DAOShips public key; accepts only sb_publishable_ keys. */
  publishableKey?: string;
  /** Defaults to the network's schema. Overrides retain the network's chain check. */
  schema?: string;
  /** Enable only after applying/backfilling the indexer's optional record-ordering migration. */
  recordOrdering?: boolean;
  signal?: AbortSignal;
  /** Startup freshness/lag requirements; maxAgeMs defaults to 5 minutes, using the local clock. */
  health?: Pick<IndexerHealthOptions, 'expectedBlock' | 'maxBlockLag' | 'maxAgeMs' | 'maxFutureSkewMs'>;
}

/**
 * Connect to the hosted public indexer and reject an uninitialized, wrong-chain or
 * reindex-required checkpoint. No network request occurs merely by importing the SDK.
 * Startup health is an observation, not an ongoing availability or finality guarantee.
 */
export async function connectDaoShipsSupabase(options: DaoShipsSupabaseOptions) {
  const network = options?.network;
  if (typeof network !== 'string' || !Object.hasOwn(DAOSHIPS_INDEXER_NETWORKS, network)) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Select the mainnet or testnet indexer explicitly.');
  }
  const { signal, fetch, timeoutMs, maxResponseBytes, recordOrdering = false } = options;
  if (typeof recordOrdering !== 'boolean') throw new DaoShipsError('INVALID_ARGUMENT', 'recordOrdering must be boolean.');
  const { chainId, schema: defaultSchema } = DAOSHIPS_INDEXER_NETWORKS[network];
  const url = options.url ?? DAOSHIPS_SUPABASE.url;
  const publishableKey = options.publishableKey ?? DAOSHIPS_SUPABASE.publishableKey;
  const schema = options.schema ?? defaultSchema;
  const healthOptions = { ...options.health, maxAgeMs: options.health?.maxAgeMs ?? 300_000 };
  if (typeof publishableKey !== 'string' || !/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey) || publishableKey.length > 512) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a Supabase publishable key, not an anonymous JWT or privileged key.');
  }
  let project: URL;
  try { project = new URL(url); }
  catch { throw new DaoShipsError('INVALID_ARGUMENT', 'Expected a Supabase project URL.'); }
  if (project.protocol !== 'https:' || project.username || project.password || project.search || project.hash || project.pathname !== '/') {
    throw new DaoShipsError('INVALID_ARGUMENT', 'Expected an HTTPS Supabase project origin without credentials, path, query or fragment.');
  }
  if (project.origin !== DAOSHIPS_SUPABASE.url && options.publishableKey === undefined) {
    throw new DaoShipsError('INVALID_ARGUMENT', 'A custom Supabase project requires its own explicit publishable key.');
  }
  const indexer = new DaoShipsIndexer({ url: project.origin, key: publishableKey, schema,
    ...(fetch === undefined ? {} : { fetch }), ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(maxResponseBytes === undefined ? {} : { maxResponseBytes }),
  });
  const checkpoint = await indexer.getStateDetails(signal);
  const health = assertIndexerHealthy(checkpoint, { ...healthOptions, chainId, nowMs: Date.now() });
  return Object.freeze({ network, chainId, schema, indexer, data: new DaoShipsData(indexer, { recordOrdering }),
    checkpoint: Object.freeze(checkpoint!), health: Object.freeze(health),
  });
}
