# Final indexer/app integration review

This SDK-only review compared actual queries in the application's indexer services, the website's `lib/stats.ts`, and the indexer's Poster/navigation handlers. Public table coverage alone did not cover every useful query or materialization workflow.

## Implemented query gaps

- **Exact website totals:** `count(table, { filters, where, signal })` issues `HEAD` with `Prefer: count=exact` and returns `bigint`. It validates `Content-Range`, rejecting unknown, malformed or inconsistent totals. It shares existing timeout, cancellation, HTTP errors, URL validation and redirect protections. Counts reflect rows visible under the endpoint's access policy, not independently authenticated chain totals. Pagination is deliberately absent from its public options.
- **Active membership:** `listActiveMembers(dao, options)` and `countActiveMembers(dao, options)` add `(shares > 0 OR loot > 0)` while enforcing DAO scope. Historical zero-balance members remain available through existing methods. This matches `MemberIndexerService`'s active roster predicate.
- **Composed filters:** `where` accepts existing typed leaves and nested `{ any: [...] }` / `{ all: [...] }` groups. `filters` and top-level `where` entries are always ANDed. Conditions support `is` / `not.is` with null on nullable scalar columns or JSON text paths. Null is not a string literal.
- **Targeted metadata:** JSON conditions use `{ column: 'content_json', path: ['proposalId'], operator: 'eq', value: 42 }`. Paths are valid only on schema-declared JSON columns. Intermediate segments use `->` and the final segment uses `->>`; comparisons operate on extracted **text**, so range comparisons are lexicographic, not numeric casts. Exact proposal/navigator identity comparisons avoid downloading unrelated permissionless posts. Path segments are bounded identifiers; arbitrary SQL, casts and array selectors remain excluded.
- **Orphan-aware allowlist discovery:** `getNavigatorAllowlist(dao, navigator, signal?)` selects the latest matching tag and JSON navigator address from the requested DAO or `dao_id IS NULL`, covering the indexer's pre-DAO/reparenting window. It rechecks returned DAO/tag/navigator identity. It does not download IPFS or authenticate the returned root against chain state; callers must use the SDK's existing allowlist/root validation against the navigator's actual root.
- **DAO text search:** `ilike` is supported on text columns and extracted JSON text. It accepts an explicit PostgREST wildcard pattern. `%` matches any sequence, `_` one character, and PostgREST treats `*` as an alias for `%`. Backslash escapes `%`, `_` and backslash according to PostgreSQL LIKE rules. The SDK preserves supplied backslashes and quotes. Use `eq` for literal equality; do not treat arbitrary user input as an already-escaped wildcard pattern. Literal substring matching for input containing `*` requires caller-side filtering or a dedicated upstream search endpoint.
- **Proposal list payloads:** `listProposalSummaries(dao, options)` returns complete indexed proposal fields except `proposal_data`. The app already excludes that potentially large action blob from repeated list requests. Exact proposal numbers, data hashes and lifecycle metadata remain present; `getProposalDetails` supplies the full payload when needed.

```ts
const active = await indexer.countActiveMembers(dao);
const totals = await Promise.all(['daos', 'members', 'proposals'].map(table =>
  indexer.count(table as 'daos' | 'members' | 'proposals'),
));
const reasons = await indexer.list('records', {
  filters: { dao_id: dao.toLowerCase(), tag: 'daoships.proposal.vote.reason' },
  where: [
    { column: 'content_json', path: ['proposalId'], operator: 'eq', value: 42 },
    { column: 'trust_level', operator: 'in', value: ['MEMBER', 'VERIFIED', 'VERIFIED_INITIAL'] },
  ],
  orderBy: 'created_at', direction: 'desc',
});
```

Vote-reason authors still need cross-checking against `ds_votes` for that composite proposal ID. The app's existing service falls back to records alone if its vote cross-reference fails; the SDK does not add that fail-open shortcut. Typed indexed rows, permission labels and metadata are not transaction authorization.

## Bounds and tests

Queries permit at most 100 condition/group nodes, four nested grouping levels, 1,000 aggregate condition values, eight JSON path segments (64 characters each), 16,384 characters per filter string, and 65,536 encoded URL characters. Sparse condition/path arrays and unsafe columns/operators/paths are rejected. Iteration snapshots query data on first consumption so later caller edits cannot change its filter identity between pages. Request cancellation retains the original supplied signal even if the options object is mutated.

`test/final-indexer-review.test.mjs` tests actual app predicates, nested groups, exact JSON identity extraction, wildcard escaping, HEAD count precision/errors/deadlines, malformed paths/budgets, orphan discovery and returned identity, proposal projections, and mutation/cancellation boundaries. `test/types.ts` verifies valid nested queries and rejects unknown tables/columns, paths on scalar columns, JSON comparisons without paths, numeric wildcard comparisons, lossy balance values, paginated counts and action payload access on summaries.

These are offline transport and type tests. Hosted PostgREST parser/version acceptance, query plans and access policies remain deployment checks. Live subscriptions, cache invalidation on reorg deletes, IPFS transport, joins between different entity tables and application rendering remain integration-owned services.

## Materialization findings beyond query capabilities

- Signal and Budget events are materialized only for sanctioned navigators; later sanctions can trigger backfill. Revocation does not erase historical rows. A checkpoint reaching a block does not establish that an unsanctioned navigator's rows exist or that a previously materialized navigator remains trusted. Source: indexer `handlers/signal.ts` and `handlers/budget.ts` materialization gates.
- Signal label records may exist even when creator/time/option-count checks prevent labels from being applied. Consumers should use the materialized poll's `options`/`labels_block_number` for applied labels, not simply the newest raw `daoships.signal.poll` record. Source: `handlers/poster.ts` record insertion and `applySignalPollLabels`.
- The initial DAO profile remains a historical record after vault governance controls the profile. `ds_daos.profile_source` and materialized name/description/avatar indicate applied state; raw newest initial-profile records are not sufficient to determine current authority. Source: `handlers/poster.ts` initial-profile routing guard.
- DAO profile null-clearing and globally scoped member-profile handling exposed builder/indexer mismatches and were handed to the parallel protocol review for SDK fixes. No sibling indexer or app source was modified here.
