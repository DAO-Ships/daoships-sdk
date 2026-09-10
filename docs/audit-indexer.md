# Indexer audit — 2026-09-09

Scope: `src/indexer.ts`, `src/indexer-models.ts`, `src/indexer-sync.ts`, the sibling indexer's public SQL schema and lifecycle handler key formats. This is a source and offline adversarial transport audit, not a deployed PostgREST or infrastructure penetration test.

## Findings and fixes

| Severity | Finding / reproduction | Resolution |
| --- | --- | --- |
| Medium | A server can return a huge response body; the prior `response.json()` allocates/parses it before checking row count. A timeout cannot interrupt synchronous JSON parsing. | Native Fetch bodies are streamed under a configurable `maxResponseBytes` budget (16 MiB default), including chunked responses. Oversized declared lengths fail early. Readers are cancelled on size errors, abort, timeout and HTTP failure. Invalid UTF-8 is rejected. |
| Medium | Deeply nested metadata recursively invokes `isJson`, causing stack exhaustion; a custom transport can provide cycles or non-JSON objects. | Iterative validation bounds each JSON field to 64 nesting levels and 100,000 nodes. Cycles, nonfinite numbers, undefined values and non-plain objects fail with `INVALID_RESPONSE`. Row fields must be own properties. |
| Medium | An endless endpoint that ignores `offset` makes `iterate()` run indefinitely. | Consecutive repeated page identities fail with `INVALID_RESPONSE`. `maxPages` defaults to 10,000 requests, including the final empty page; exceeding it raises `INDEXER_ERROR`. The caller can explicitly adjust the budget. Cancellation remains checked between yielded rows. |
| Medium | `nowMs` stays frozen during checkpoint polling, so a checkpoint may remain “fresh” after the caller's age threshold has elapsed. Far-future checkpoint timestamps also previously passed all freshness checks with age zero. | Polling advances the explicit clock using elapsed monotonic time. Timestamps exceeding `maxFutureSkewMs` (60 seconds default when a clock is supplied) fail validation. Timestamps require an ISO date/time with timezone. |
| Low | The exported `indexerShapes` descriptors are compile-time readonly but can be modified by JavaScript consumers, changing column validation and projections process-wide. | Freeze the table map and every column descriptor at runtime. This prevents accidental/in-process mutation; it is not an isolation boundary against arbitrary code execution. |
| Low | JSON-stringifying a PostgREST quoted filter encodes newline as `\\n`; PostgREST's backslash grammar consumes that as `n`, querying a different literal. Unquoted reserved characters in equality values can also be interpreted differently. | Quote reserved equality literals and escape only double quotes and backslashes for PostgREST. Control characters remain intact through URL encoding. Tests decode according to PostgREST's quoted-literal rule and verify the original value. See [PostgREST URL grammar](https://docs.postgrest.org/en/stable/references/api/url_grammar.html). |
| Low | Compact DAO, member and proposal projections reject valid database nulls in balances and status booleans, although the public SQL columns are nullable. | Compact row types and validators now preserve these nulls, matching complete projections. Consumers must handle null when data is not initialized. |
| Low | Decimal response fields accept noncanonical or arbitrarily long strings; externally supplied checkpoint/block IDs can trigger unnecessarily large bigint parsing. | Response amounts require canonical unsigned decimal strings of at most 78 digits, matching SQL NUMERIC precision. Exact lookup IDs and string checkpoint blocks are length-bounded before bigint conversion. |

## Verification

`test/audit-indexer.test.mjs` contains 12 regression tests covering streamed byte budgets and inclusive limits, invalid budget arguments, body cancellation, timeout/abort races, invalid UTF-8, absent/erroring streams, metadata complexity/cycles/prototypes, immutable allowlists, literal preservation, repeated-page and request-budget errors, nullable compact reads, canonical numerics, all 21 DAO-scoped lifecycle feeds, 13 detail lookup key mappings, future-clock policy and timestamps aging during polling.

The existing schema parity test independently compares all 25 public SQL tables, column names, numeric casts and nullability against `daoships-indexer/supabase/migrations/schema.sql`. Existing tests cover 256-bit tally precision, handler composite IDs, capped pagination, condition ranges, timeout behavior and chain/reindex checkpoint failures.

Executed successfully after changes (27 test cases via direct imports, avoiding sandbox worker-spawn limitations):

```sh
npm run build
node --input-type=module -e 'await import("./test/audit-indexer.test.mjs"); await import("./test/indexer.test.mjs"); await import("./test/indexer-sync.test.mjs");'
```

## Remaining boundaries

- Native Fetch response bodies receive byte enforcement before parsing. A caller-supplied partial Fetch shim that exposes only `json()` remains supported for compatibility; that shim owns buffering/allocation limits. Returned metadata still passes the shape/complexity checks, and the outer request deadline still applies.
- The byte budget limits synchronous parsing input, but JavaScript timers cannot preempt parsing while it is running. Increase the budget only with an appropriate memory/latency budget.
- Offset pagination is not a database snapshot. Concurrent insertions/deletions can cause omissions or duplication across different pages. Repeated-page detection prevents obvious non-progress, not every change in the dataset. Consumers requiring a snapshot must coordinate an upstream snapshot/export.
- A committed indexer checkpoint establishes reported progress, not chain finality, inclusion of a specific transaction, completeness of every handler, or honesty of a remote endpoint. Transaction authorization must use the protocol's on-chain checks.
- The indexer remains a read-only client of all 25 public tables. Operational/internal tables are intentionally excluded. Metadata is untrusted application content, including ordinary JSON keys such as `__proto__`; the SDK does not execute it or assign its keys onto application objects.
- No live hosted PostgREST acceptance, production key validation, database access-policy audit or real network load/fault test was performed in this sub-audit. Public URLs and caller-provided publishable keys remain the integration's responsibility.
