import { DAOSHIPS_SUPABASE, DAOSHIPS_INDEXER_NETWORKS } from '../dist/supabase.js';
import { testLiveIndexer } from './test-live-indexer.mjs';

try {
  const network = process.argv[2];
  if (process.argv.length !== 3 || !Object.hasOwn(DAOSHIPS_INDEXER_NETWORKS, network)) {
    throw Object.assign(new Error('Select mainnet or testnet.'), { code: 'INVALID_NETWORK', stage: 'configuration' });
  }
  const { schema, chainId } = DAOSHIPS_INDEXER_NETWORKS[network];
  console.log(JSON.stringify(await testLiveIndexer({
    SUPABASE_URL: DAOSHIPS_SUPABASE.url, SUPABASE_PUBLISHABLE_KEY: DAOSHIPS_SUPABASE.publishableKey,
    DAOSHIPS_INDEXER_SCHEMA: schema, DAOSHIPS_CHAIN_ID: String(chainId),
  }), null, 2));
} catch (error) {
  console.error(JSON.stringify({ status: 'failed', code: error.code, stage: error.stage, ...(error.reason ? { reason: error.reason } : {}) }));
  process.exitCode = 1;
}
