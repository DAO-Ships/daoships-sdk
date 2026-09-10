# Data integration APIs

The SDK now supplies IPFS allowlist retrieval/pinning adapters, transport-neutral realtime reconciliation, a structural Supabase bridge, and bounded cross-table reads. These use caller-selected endpoints and chain readers. Indexed metadata remains untrusted content; successful joins do not create cryptographic author authentication.

## IPFS allowlists verified against a chain root

```ts
import { fetchIpfsAllowlist, Navigator } from '@daoships/sdk';

const navigator = new Navigator('OnboarderNavigator', navigatorAddress, provider);
const verified = await fetchIpfsAllowlist({
  cid: record.content_json.ipfsCid,
  // gateway is optional; content defaults to https://ipfs.io.
  account: walletAddress,
  expectedRoot: record.content_json.root,
  readRoot: signal => navigator.read('allowlistRoot', [], { signal }),
  timeoutMs: 15_000,
  maxBytes: 2_000_000,
  signal,
});
if (verified.member) {
  // verified.proof is suitable for the navigator's caller-specific allowlist check.
}
```

`readRoot` is mandatory and must read the intended navigator from the caller's trusted chain/provider context. It runs before and after retrieval. A metadata-root mismatch or a fetched tree that differs from the chain root raises `HASH_MISMATCH`; a root change during retrieval raises `PLAN_CHANGED`. A verified nonmember returns `member: false, proof: null`. Zero/open roots are rejected by this retrieval function because they require no membership document.

See [IPFS reads](IPFS.md) for contract/content gateway defaults, integrity guarantees and current live availability.

The gateway accepts either a bare HTTP(S) origin/prefix or an `/ipfs/` suffix. Credentials, query strings and fragments are rejected, redirects are disabled, and no API key or Authorization header is forwarded. CID validation decodes the multibase/multihash structure: CIDv0 SHA-256 dag-pb and lowercase base32 CIDv1 SHA-256 raw/dag-pb are supported. Paths, IPNS names, mutable pointers and unsupported codecs are rejected.

The response must expose a native-compatible streamed body. The default 2 MB byte budget is enforced before JSON parsing and can be raised to 16 MiB. Direct StandardMerkleTree dumps and `{ treeDump: ... }` wrappers are accepted. Existing SDK tree validation checks every parent/leaf/value index; the returned proof is independently verified. The shared deadline includes the chain reads and response body, including transports that ignore abort. As with other JavaScript input limits, a timer cannot preempt synchronous parsing/hashing; bounded input is the protection against that work becoming unbounded.

The CID is structurally validated; this helper does not implement a full IPFS DAG/UnixFS verifier. The content authenticity relevant to membership is established by its Merkle root matching both caller-owned chain reads. Retrieval is not proof of transaction inclusion or assurance that the root will remain unchanged before a later transaction.

## Upload/pinning through a caller-owned adapter

```ts
import { publishAllowlist } from '@daoships/sdk';

const published = await publishAllowlist(tree, {
  async pin({ content, filename, contentType }, signal) {
    // Your provider's authenticated upload/pinning implementation.
    return uploadToYourPinningService({ content, filename, contentType, signal });
  },
  timeoutMs: 15_000,
  signal,
});
```

The SDK validates the complete tree and supplies canonical UTF-8 JSON bytes, stripping unrelated object fields. The same default 2 MB/max 16 MiB document bounds apply. The adapter returns either a CID string or `{ cid }`, and the CID is structurally validated before return. No provider-specific credentials, account setup or external pinning package is required.

The result explicitly distinguishes `verification: 'local-tree-only'` from `storageVerification: 'adapter-reported-cid'`. A pinning adapter's successful response does not prove retrievability, persistence, CID/content correspondence, or current on-chain membership authority. Use `fetchIpfsAllowlist` against the intended chain root to establish retrieval/root verification. Unit tests use fake adapters; SDK development validation does not perform real uploads.

## Realtime subscriptions with precision-safe reconciliation

```ts
import { watchIndexer, supabaseRealtimeAdapter } from '@daoships/sdk';

const watch = await watchIndexer(indexer, 'members', {
  schema: 'testnet',
  query: { filters: { dao_id: dao.toLowerCase() } },
  maxRows: 5_000,
  maxPages: 100,
  onSnapshot(snapshot) {
    renderMembers(snapshot.items, { complete: snapshot.complete });
  },
  onError(error) { showRefreshFailure(error); },
  subscribe: supabaseRealtimeAdapter(supabase, {
    schema: 'testnet', table: 'members', channelName: 'dao-member-feed',
    filter: { column: 'dao_id', value: dao.toLowerCase() },
  }),
  signal,
});

await watch.refresh(); // manual reconciliation when needed
await watch.close();   // unsubscribe and stop future refreshes
```

No Supabase runtime dependency is added. `supabaseRealtimeAdapter` accepts a structurally compatible client, validates the schema/table and optional single scalar equality filter, maps SUBSCRIBED to reconciliation, reports CHANNEL_ERROR/TIMED_OUT/unexpected CLOSED, and calls `removeChannel` exactly once on cleanup or abort. It rejects complex filter syntax; leave such predicates in `watchIndexer.query`. If a transport cannot reliably emit changes for rows that leave its server filter, omit the subscription-level filter and keep only the SDK query filter so those changes still invalidate the view.

Custom integrations can supply the same `RealtimeSubscribe` callback contract with any transport. A change envelope must match the configured schema, `ds_` table name, and INSERT/UPDATE/DELETE event type. `new`/`old` row data is deliberately ignored: database realtime transports may have already rounded BIGINT/NUMERIC values. Every event invalidates and refetches through the SDK's text-cast, schema-validated PostgREST queries. A DELETE therefore removes rows according to a fresh query; updates that enter/leave a filter are reconciled the same way when the transport delivers their invalidations.

`onReconnect()` and `onReorg()` request the same reconciliation. The application maps its transport's reconnection status or its chain observer's reorg notification to those callbacks. This avoids pretending an unobserved or disconnected event stream is gap-free. The initial subscription starts before the initial read, and invalidations observed during a read schedule another read; the delivered snapshot marks `invalidatedDuringRead`.

The implementation holds one pending read and one coalesced invalidation flag, rather than buffering arbitrary event rows. Debouncing defaults to 100 ms (minimum 10 ms). Async snapshot callbacks provide backpressure and share the refresh deadline. If an observer remains pending at the deadline, the watch closes and unsubscribes so subsequent invalidations cannot accumulate overlapping callbacks. Refetch failures retain the last successful snapshot and set `lastError`; error observers are notified. Closing, aborting and initialization failure unsubscribe; a subscription that resolves after timeout still has its cleanup called. Repeated `close()` calls await the same cleanup. Underlying caller code that ignores its signal cannot be forcibly terminated by the SDK.

All snapshots explicitly report `atomic: false`, `consistency: 'eventually-consistent'`, and row/page completeness. Offsets and query data are held stable for the watch, but concurrent database writes still prevent transactional snapshot guarantees. Freshness is observation-based, not a claim that no update occurred after the final read.

## Cross-table DAO, member and proposal reads

```ts
import { DaoShipsData, buildDaoProfileUpdate } from '@daoships/sdk';

const data = new DaoShipsData(indexer);
const current = await data.getDaoProfile(dao, { chainId: 15000, signal });
if (current.complete && current.checkpointStable) {
  const update = buildDaoProfileUpdate(dao, current.metadata, { theme: nextTheme });
}

const member = await data.getMemberProfile(dao, wallet, { chainId: 15000, signal });
const proposal = await data.getProposal(dao, 42, {
  chainId: 15000, pageSize: 100, maxRows: 2_000, maxPages: 50, signal,
});
```

`getDaoProfile` combines the DAO's materialized name/description/avatar with the latest eligible profile record's banner/theme/links/tags/chain ID. A `profile_source: 'vault'` DAO excludes subsequent initial-profile records. Otherwise both initial and governance records are considered: a banner/theme-only governance post need not change `profile_source` in the current indexer. Records must match DAO identity, allowed author identity, tag, indexed trust label and Poster schema. A DAO with a recorded profile source but missing corresponding metadata reports `complete: false`.

By default, profile reads inspect the newest two eligible records, ordered by the SQL block number descending, with at most two requests when the server caps pages. If both records share a block, or either lacks a block number, the baseline projection cannot prove which came last: it has no transaction/log ordering columns, and the hash-based ID is not execution order. The result reports `profileAmbiguous: true`, `profileReason: 'ambiguous-record-order'`, `profile: null` and `complete: false`. DAO materialized fields remain available; record-only metadata is omitted. Do not construct a profile update from incomplete metadata, since omitted current fields could otherwise be cleared. Resolve ambiguous order from canonical chain logs or enable the migrated indexer capability below. Distinct blocks are ordered numerically in SQL even when their numbers exceed JavaScript's safe integer range or their timestamps match.

For schemas with the prepared record-ordering migration applied, opt in with `new DaoShipsData(indexer, { recordOrdering: true })` (or the same option on `connectDaoShipsSupabase`). `indexer.listOrderedRecords()` exposes the additive `transaction_index` and `log_index` columns using canonical block/transaction/log ordering. Both coordinates come from actual Quai logs; the migration leaves historical values NULL until receipt-verified backfill. Unknown positions sort first within their block, so a known new record cannot conceal an unordered legacy record. Distinct, known positions resolve same-block profiles; mixed/unknown positions or duplicate coordinates remain ambiguous. Enabling the capability against an unmigrated schema fails visibly. The default projection never requests these columns, preserving hosted-service compatibility throughout rollout. See the upstream rollout and backfill procedure in the indexer repository’s `docs/RECORD_EVENT_ORDER.md`; preparation is not evidence that a hosted migration or backfill has run.

`getMemberProfile` joins a concrete composite membership key with the latest same-DAO profile authored by that member and validates its Poster schema. It uses the same ambiguity checks and completeness fields. Null membership/profile results remain null; current balances do not retroactively prove whether a historical author was a member when posting.

`getProposal` joins an exact proposal key, all bounded vote pages, and targeted vote-reason metadata pages. A returned `reasons` record must have a successfully retrieved vote from its author, the same DAO/proposal ID, an accepted trust label, a valid Poster schema, and a matching vote choice if the content includes one. Vote transport failures fail the whole join; there is no records-only fallback. `reasonRecords` retains the raw retrieved candidates separately, and `excludedReasonCount` reports how many failed the vote/content checks. Incomplete vote pagination can exclude legitimate reasons; the result explicitly reports incompleteness instead of calling those authors unauthenticated.

Every joined read brackets its queries with indexer checkpoints and validates the expected chain and reindex flags. `checkpointStable` requires unchanged block/hash observations and a non-null hash; it does **not** turn sequential HTTP requests into a database transaction. Returned `trust: 'indexer-claims-only'` distinguishes indexed identity checks from signatures or independently verified chain authorship. Limits default to 2,000 rows, 50 pages, 100 rows/page per joined table, and 30 seconds overall. Hitting a row/page budget reports `complete: false` and the reason; only an empty page proves exhaustion, so a dataset exactly at the row limit is conservatively incomplete.

Offline tests cover CID/gateway rejection, proof/root validation and changes, streamed resource limits, pinning adapter payloads/trust distinctions, transport deadlines, profile source/author checks, vote-reason impersonation/mismatch rejection, exact balances, pagination/checkpoint drift, realtime burst coalescing, structural Supabase status/filter/cleanup behavior, malformed envelopes/rows, deletes/reconnects/reorgs, and cleanup/abort races. The focused test run measured 100% line/function and over 95% branch coverage for `data-integrations.js`. A separate strict TypeScript consumer also verified compatibility with the sibling app's real Supabase v2.95.3 client types; the SDK did not add that package as a dependency. Live IPFS gateway availability, actual Supabase channels and production database snapshot semantics remain environment acceptance checks.
