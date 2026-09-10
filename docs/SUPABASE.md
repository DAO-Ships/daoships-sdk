# Hosted Supabase integration

The SDK ships the DAOShips Supabase project URL and its public publishable key. Select a
network explicitly; connecting reads its checkpoint and checks the reported chain,
reindex flag and timestamp. The default maximum checkpoint age is five minutes.

```ts
import { connectDaoShipsSupabase } from '@daoships/sdk';

const connection = await connectDaoShipsSupabase({ network: 'mainnet' });
const daos = await connection.indexer.listDaos({ limit: 25 });
const count = await connection.indexer.count('daos'); // exact bigint
const profile = await connection.data.getDaoProfile(daoAddress, {
  chainId: connection.chainId,
});
// Check profile.complete before carrying metadata forward into an update.
```

`mainnet` selects chain 9/schema `mainnet`; `testnet` selects chain 15000/schema `testnet`.
There is no implicit network or fallback to the app's local `dev` schema. The exported
`DAOSHIPS_SUPABASE` and `DAOSHIPS_INDEXER_NETWORKS` constants are frozen. No network
request, environment lookup, wallet access or session creation occurs at import time.

The returned connection contains `indexer`, `data`, `network`, `chainId`, `schema`,
`checkpoint` and `health`. Checkpoint/health are frozen startup observations; they do not
update themselves or prove finality. Refresh health using `indexer.getStateDetails()` and
`assertIndexerHealthy` before operations that require current indexed data. Joined reads
check chain/reindex state but do not automatically inherit this connector's age policy.

## Overrides and health policy

```ts
const connection = await connectDaoShipsSupabase({
  network: 'testnet',
  url: ownSupabaseProjectUrl,
  publishableKey: ownPublishableKey,
  schema: 'dev', // still checked against chain 15000
  timeoutMs: 10_000,
  maxResponseBytes: 2_000_000,
  health: { maxAgeMs: 60_000, expectedBlock: knownChainHead, maxBlockLag: 10n },
  signal,
});
```

A custom project requires its own explicit publishable key. The connector accepts only
HTTPS project origins and `sb_publishable_` keys. A key override on the default project
supports rotation without changing consumers' other configuration. Keys are sent in the
`apikey` header, never as a bearer JWT or URL parameter, and redirects are disabled.
Anonymous JWTs and privileged keys are rejected by this hosted connector; the existing
low-level `DaoShipsIndexer` remains available for explicitly configured integrations.

Startup rejects missing checkpoints, wrong chains, reindex-required state, stale/missing
timestamps, and any supplied block-lag violation. Freshness uses the local system clock,
with the existing bounded future-clock-skew check. Raising `health.maxAgeMs` is an
explicit application policy; it does not make historical data current. Low-level reads
can inspect a stale indexer when diagnosing it.

## Public read boundary

This integration issues GET/HEAD requests to the existing public PostgREST projections.
It does not write application recovery records or mutate the indexer's database. Supabase
grants and row-level policies govern actual access; a publishable key by itself is not a
read-only policy. See [Supabase's key documentation](https://supabase.com/docs/guides/getting-started/api-keys).

HTTP integration uses Fetch and adds no runtime package dependency. Applications that
already use Supabase's JavaScript client can pass it to `supabaseRealtimeAdapter` and
`watchIndexer`; see [data integrations](DATA_INTEGRATIONS.md). No realtime connection is
opened implicitly. Supabase availability, project quotas and public-key rotation affect
hosted reads, while generic contract encoding and caller-owned RPC operations remain
available independently.

Indexed results support discovery/history and catch-up. Before signing, verify the
relevant DAO state through the chain provider. After broadcast, verify receipt/business
outcome before checking indexed convergence. `waitForIndexedBlock` observes checkpoint
progress; it does not prove a specific entity was indexed or that a transaction is final.

## Repeatable live acceptance

```sh
npm run test:indexer:hosted -- mainnet
npm run test:indexer:hosted -- testnet
```

These workspace-only opt-in checks use the bundled public connection, require an explicit network, and
make bounded read-only requests. The ordinary test/coverage suite remains offline.
For a custom project, explicitly set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
`DAOSHIPS_INDEXER_SCHEMA` and `DAOSHIPS_CHAIN_ID`, then run `npm run test:indexer:live`.
`DAOSHIPS_INDEXER_MAX_AGE_MS` optionally overrides its five-minute freshness threshold.
Missing configuration or failed checks exit unsuccessfully; they never count as skipped
acceptance. The hosted command always uses the default freshness threshold.

The check validates all 25 public table projections, exact visible counts, bounded sample
DAO/member/proposal joins and before/after checkpoints. Empty tables are explicitly
reported as unexercised for row validation; sampled queries are not exhaustive. Reports
contain counts and health observations, without keys, indexed content or raw transport
errors. No writes, public transactions, realtime delivery or IPFS availability are tested.

See [release readiness](RELEASE_READINESS.md) for observed live results and remaining gaps.

## Optional canonical record ordering

After deploying the indexer's transaction/log-position migration and updated handler,
pass `recordOrdering: true` to `connectDaoShipsSupabase`. Its `data` facade then requests
optional record positions and resolves known same-block order. The default remains false
for compatibility with existing hosted schemas. Enabling this option against an unmigrated
schema fails on the first ordered record read; startup does not migrate or probe those columns.
Missing historical positions stay incomplete when their order matters. Apply the migration
and use the indexer receipt backfill procedure before claiming complete historical profiles.

`npm run test:realtime:live -- testnet` exercises a real checkpoint subscription, a forced
transport reconnect, subsequent snapshot refresh and channel cleanup. It uses the sibling
app's installed Supabase client without adding it to SDK runtime dependencies. It performs
no database writes and does not induce a reorg.
