# Indexer integration coverage

`DaoShipsIndexer` covers all 25 public tables in the sibling indexer's
`supabase/migrations/schema.sql`. This is an eventually consistent read model;
verify executable state and permissions on chain before submitting transactions.

## Complete table API

```ts
const indexer = new DaoShipsIndexer({ url, key, schema: 'testnet' });
const page = await indexer.list('vesting_schedules', {
  filters: { dao_id: dao.toLowerCase(), beneficiary: wallet.toLowerCase(), revoked: false },
  orderBy: 'start_time', direction: 'desc', limit: 100, signal,
});

for await (const payment of indexer.iterate('subscription_payments', {
  filters: { navigator_address: navigator.toLowerCase() },
  where: [{ column: 'block_number', operator: 'gte', value: 42n }],
  orderBy: 'block_number', limit: 100, signal,
})) {
  const exactAmount = BigInt(payment.amount);
}
```

Use `new DaoShipsIndexer(options)` directly if an integrator only needs indexed
reads. `list(table, options)`, `get(table, primaryKey, signal)` and
`iterate(table, options)` return the corresponding `IndexerTables[table]` model.
Table keys omit the `ds_` prefix. Filters are typed scalar equality conditions;
`null` uses SQL `IS NULL`. `where` supplies additional AND conditions with
`eq`, `neq`, `gt`, `gte`, `lt`, `lte`, and `in`, plus explicit text `ilike` patterns
and nullable-column `is` / `not.is` conditions. Nested `{ any: [...] }` and
`{ all: [...] }` groups compose OR and AND predicates. JSON columns support bounded
identifier paths through `{ column: 'content_json', path: ['proposalId'],
operator: 'eq', value: 42 }`; these extract and compare text, not numeric casts.
String literals are escaped inside compound filters. Joins, arbitrary SQL/RPCs,
and realtime subscriptions remain integration-owned. See the
[final integration review](final-indexer-review.md) for query bounds and examples.

Sort by any schema column with `orderBy` and `direction`; a primary-key tiebreaker
is added automatically. The default is `id.asc`. `nextOffset` advances by rows
actually returned, even when the service imposes a smaller page cap. Only an empty
page indicates exhaustion. Offset pagination is not a database snapshot: concurrent
updates, insertions, deletions and reorgs can cause omissions or duplicates across
requests. For ingestion, use block bounds, persist identifiers, and reconcile a
confirmation window. `iterate` is cancellable, snapshots its query on first
consumption, rejects consecutive repeated pages, and raises an explicit error
if its `maxPages` request budget is exhausted (default 10,000).

## Coverage map

| Table keys | Convenient methods | Integration purpose |
| --- | --- | --- |
| `daos`, `members`, `proposals`, `indexer_state` | Existing compact `listDaos`, `getDao`, `listMembers`, `listProposals`, `getProposal`, `getState`; full `getDaoDetails`, `getProposalDetails`, `getMember`, `getStateDetails` | DAO config, metadata, supply, members/delegates, proposal lifecycle, sync/reindex health |
| `votes` | `listVotes`, `getVote` | Governance voting breakdown, exact snapshot balances |
| `navigators` | `listNavigators`, `listSanctionedNavigators`, `getNavigator` | Navigator discovery, configuration, permission and trust state |
| `guild_tokens`, `ragequits`, `delegations` | `listGuildTokens`, `listRagequits`, `listDelegations` | Treasury token registry, exit history, delegation history |
| `records`, `event_transactions` | `listRecords`, `listEventTransactions` | Poster metadata and transaction linkage |
| `navigator_events`, `nft_claims` | `listNavigatorEvents`, `listNftClaims`, `getNftClaim` | Onboarding, checkin/slash activity, per-token NFT claim ledger |
| `signal_polls`, `signal_votes` | `listSignalPolls`, `getSignalPoll`, `listSignalVotes`, `listPollVotes`, `getSignalVote` | Snapshot signaling, option labels, exact tallies and votes |
| `timelock_changes` | `listTimelockChanges`, `getTimelockChange` | Queued/executed/cancelled changes and executable config bytes |
| `vesting_schedules`, `vesting_claims` | `listVestingSchedules`, `getVestingSchedule`, `listVestingClaims` | Schedule state, revocations, incremental claim feed |
| `budgets`, `budget_disbursements` | `listBudgets`, `getBudget`, `listBudgetDisbursements` | Treasury budget state and recipient disbursements |
| `subscription_members`, `subscription_payments`, `subscription_collections` | `listSubscriptionMembers`, `getSubscriptionMember`, `listSubscriptionPayments`, `listSubscriptionCollections` | Enrollment, paid-through state, payments, enforcement and rewards |
| `vault_module_events`, `governance_config_history` | `listVaultModuleEvents`, `listGovernanceConfigHistory` | Module trust history and governance/timelock bypass audit |

Every named `list*` feed above takes `(dao, options)` and supports the same typed
filters, sorting and pagination as `list`. Mandatory DAO scoping wins over an
options filter. `listPollVotes(navigator, pollId, options)` scopes to a poll.
Navigator detail methods take `(navigator, id, signal?)`; IDs accept canonical
decimal strings or uint256 bigint, including zero. `getSubscriptionMember` takes
`(navigator, member, signal?)`; `getNavigator` takes `(dao, navigator, signal?)`.
Generic `get` covers every table by its full primary key.

`count(table, options)` uses HEAD and `Prefer: count=exact`, returning an exact
bigint total for the filtered visible rows. `listActiveMembers` and
`countActiveMembers` include accounts with shares or loot above zero.
`getNavigatorAllowlist` targets a navigator's latest metadata record, including
pre-DAO orphan records. `listProposalSummaries` excludes the encoded action blob
while retaining full proposal identity, hash and lifecycle fields.

## Precision and compatibility

Complete projections return **all SQL BIGINT and NUMERIC columns as decimal
strings**, including block heights, timestamps, counts and per-navigator IDs.
SMALLINT/INTEGER/SERIAL columns remain validated safe JavaScript integers.
SQL nullability is preserved, including columns with defaults but no `NOT NULL`.
Compact methods preserve SQL nulls for balances and proposal flags; their numeric
proposal/checkpoint fields remain safe JavaScript integers and reject unsafe values.

Casting happens in the PostgREST selection, before JSON parsing: `amount::text`.
Signal poll `tally` is a PostgreSQL NUMERIC array, so the entire array is cast to
text and its unsigned integer elements are decoded as strings. Raw JSON numeric
arrays are rejected, because converting already rounded numbers back to strings
cannot recover precision. `options` remains a nullable text array. JSONB content
remains JSON data; arbitrary numeric values inside user metadata do not carry the
same exact-integer guarantee as schema-declared NUMERIC/BIGINT columns.

All projected fields are checked at runtime. Native Fetch response bodies are
limited to `maxResponseBytes` (16 MiB default) before parsing; JSON metadata has
depth/node limits. HTTP/network failures report
`INDEXER_ERROR`, malformed JSON or row shapes report `INVALID_RESPONSE`, caller
cancellation reports `ABORTED`, and elapsed deadlines report `TIMEOUT`. The deadline
covers fetching and consuming the response body, including custom transports that
do not honor abort. Error details include the table and HTTP status when available.

## Trust and source differences

Navigator `permission`, `permission_ever_granted`, `trust_status`, and `is_active`
represent different facts. An active Signal navigator can have zero permissions;
a Budget navigator obtains authority through vault module status. Use
`listSanctionedNavigators` for endorsed discovery and inspect current chain state
when deciding whether a navigator can execute. Listing feeds is historical and
does not implicitly join against current navigator trust: revoked navigators can
retain historical rows.

Poster records and all metadata are untrusted data. The SDK exposes `trust_level`
and typed filters, but does not authenticate authors or resolve links on behalf of
an integration. A profile selection should filter tags and acceptable trust levels;
a vote reason requires cross-checking the author's actual proposal vote.

The app's older `IndexerState` type omits `requires_full_reindex` and reindex
reason fields. Full SDK state exposes every schema field. The app frequently
selects `*` and casts the result to TypeScript types; the SDK instead validates
rows and casts SQL numeric values on the server. Internal
`ds_processed_logs` and `ds_navigator_sanction_intents` are deliberately absent;
the schema denies public access to them. Tests compare public coverage, numeric
classification and nullability directly against the sibling SQL schema.

Offline transport tests cover all projections, exact 256-bit tallies and IDs,
nullable fields, trust/DAO scoping, condition escaping, stable ordering,
server-capped pagination, cancellation and timeouts. Live PostgREST deployment
compatibility and hosted schema migration state require separate integration
verification; the SDK does not invent missing columns or silently coerce them.

## Health checks and checkpoint convergence

```ts
import { assertIndexerHealthy } from '@daoships/sdk';

const checkpoint = await indexer.getStateDetails(signal);
const health = assertIndexerHealthy(checkpoint, {
  chainId: 15000,
  expectedBlock: chainHead,
  maxBlockLag: 20n,
  nowMs: Date.now(),
  maxAgeMs: 60_000,
});

await indexer.waitForIndexedBlock(receiptBlock, {
  chainId: 15000, timeoutMs: 30_000, pollIntervalMs: 1_000, signal,
});
```

`assertIndexerHealthy` accepts complete or compact state. It checks the explicit
chain ID, refuses checkpoints flagged for a full reindex, and optionally enforces
block lag and timestamp age. Block comparisons use bigint. Age checks require an
explicit `nowMs`; `maxBlockLag` requires `expectedBlock`. Exact boundaries are
accepted. The result reports `indexedBlock`, `blockLag`, `ageMs`, and `isSyncing`.
Active indexing alone does not invalidate a committed checkpoint.

`waitForIndexedBlock(indexer, targetBlock, options)` is also exported as a standalone
function accepting any `getStateDetails(signal)` reader. It polls missing and behind
checkpoints, and returns the full state once the requested block is reached.
Wrong-chain, reindex, invalid-response, freshness and transport failures surface
immediately. The overall timeout bounds both polling sleeps and pending reads,
including custom readers that ignore abort. Caller cancellation reports `ABORTED`;
a deadline reports `TIMEOUT` with the target and last observed block.

A reached checkpoint confirms indexer progress. It does not prove chain finality,
transaction inclusion, navigator trust, or that a particular entity row was
materialized. Query the expected row and reconcile reorgs as appropriate. If
freshness options are supplied to a wait, explicit `nowMs` anchors the clock at
invocation and advances with elapsed monotonic time. Timestamps more than
`maxFutureSkewMs` ahead of that clock are rejected (60 seconds by default).
