# SDK architecture

The SDK owns DAOShips protocol semantics and typed integration interfaces. Applications own
wallet choice, secret storage, approval policy, rendering and durable transaction storage.
The package is ESM TypeScript with a pinned quais dependency and no app singleton, React,
Vite configuration or hosted service dependency.

## Layers

1. **Artifacts and types:** `abis.ts` normalizes all 16 app ABIs, including the wrapped vault
   artifacts, and adds the compiled DAOShips vault factory interface. `contract-types.ts`
   generates method arguments, return values and event types.
   `navigator-bytecodes.ts` is optional and uses contract artifacts whose compiler inputs
   are checked against the source dependency closure. Generated artifacts are checked in.
2. **Pure domain helpers:** governance/launch encoders, CREATE2 prediction/mining, proposal
   packing/hashing, token amounts and permits, navigator quotes/configuration, Poster and
   allowlist validation. They never broadcast or require application state.
3. **Read and prepare:** `ContractClient` exposes every ABI function. `Navigator` adds domain
   validation and named constructor configuration. `DaoShipsChain` provides chain-checked,
   block-pinned DAO reads and sender-aware preparation. `DaoShipsIndexer` exposes all public
   tables with exact numerics, runtime row checks, pagination, timeout and cancellation.
4. **Execution and outcomes:** applications may use their existing wallet flow or explicitly
   call `sendPreparedTransaction`. Refresh and persistence callbacks are required. Receipt
   handling distinguishes reverts, uncertain pending outcomes, proposal defeat and failed
   actions. Generic event/error decoding covers all artifact dictionaries.
5. **Recoverable workflows:** immutable DAO launch/navigator plans, fresh prerequisites,
   explicit authority executors, receipt checks and atomic deployment checkpoints.
   Transaction recovery journals intent, coordinates nonces, quarantines uncertain sends
   and verifies replacement/reorg evidence. Applications implement the durable CAS store.
6. **Data composition:** bounded profile/member/proposal joins, IPFS allowlist publishing
   and chain-root-verified retrieval, and realtime invalidation followed by exact HTTP reads.
   Structural adapters avoid mandatory Supabase or pinning-service dependencies.

The full interface is available even when a dedicated convenience helper does not exist.
This matters for integrations with vault setup, navigator administration, delegated token
voting, permits and future application workflows. [FEATURE_COVERAGE.md](docs/FEATURE_COVERAGE.md)
maps this distinction to the repository's actual protocol surfaces.

## Authority and precision

Solidity defines execution behavior and bounds. The indexer's schema and validation define
what metadata and feeds it materializes. Existing app abstractions are useful references,
but disagreements are checked against those authorities and recorded in
[INTEGRATION_NOTES.md](docs/INTEGRATION_NOTES.md). This pass changes only the SDK.

ABI integers are bigint; indexed BIGINT/NUMERIC columns are decimal strings. There is no
floating point token conversion. The PostgREST projection casts quantities and numeric
arrays before JSON parsing. Indexed text is untrusted, and indexer state is never an
implicit substitute for chain state on a preparation path.

A deployment graph with bytecode proves consistency, not that a deployment is currently
adopted. Discovery accepts an explicit root launcher and expected chain. Identifying
current production deployments requires operator context or indexer clone-liveness checks;
no static address is represented as freshly verified by this package.

## Validation strategy

- Round-trip selectors, calldata, results, constructor inputs and events against full ABIs.
- Validate protocol field order and bounds against Solidity source when the sibling source
  is present; do not require it for standalone consumer tests.
- Independent OpenZeppelin tree fixtures validate Merkle construction and proofs.
- Mock RPC tests cover pinned-block state, permissions, retention, hash checks, simulation,
  sender/network mismatch, refresh changes and uncertain confirmation outcomes.
- Mock HTTP tests cover all 25 public table projections, schema nullability, numeric arrays,
  query composition, server pagination caps, body timeouts and cancellation.
- Negative consumer type tests verify method names, overloads, argument/result types and
  separation of reads from unsigned transaction methods.
- Package smoke checks import packed JS/declarations in a separate consumer.
- Optional local Hardhat tests execute all three launch encoders, governance and all eight
  navigator deployments/lifecycles against actual DAOShip/launcher/token/MultiSend Solidity,
  with vault test doubles and source-current compiler artifacts.
- A separate local deployment suite uses source-current actual QuaiVault implementation,
  proxy and factory artifacts for launch, owner consent and navigator activation workflows.
- Fault injection tests cover atomic checkpoint races, lost persistence acknowledgements,
  restart recovery, nonce quarantine, changed chain evidence and incomplete data reads.
- Aggregate coverage gates, strict packed-package consumers and compiler AST/method-map
  checks are repeatable through `validate:workspace`. See the detailed
  [security audit](docs/SECURITY_AUDIT.md) for findings, measured coverage and runtime matrix.

## Release gates

The surface covers the checked-in protocol version, but offline coverage is not equivalent
to live integration or independent security certification. Before a public release:

- Run an opt-in testnet acceptance flow for launch, membership, proposals, each navigator,
  receipts and eventual indexer convergence. Exercise hosted PostgREST casts and actual RPC
  behavior with the pinned library. No live transactions have been sent in this work.
- Resolve the four stale app navigator bytecodes and validation/metadata discrepancies
  documented in the integration notes if app/SDK behavior must match.
- Establish artifact version ownership and release provenance across sibling repositories.
- Confirm npm scope, licensing of extracted code/bytecode and public package policy; this
  package remains private and unpublished.
- Select supported indexer credentials/schema and measure agent/application traffic before
  deciding whether a separate API or rate-limit layer is needed.

Native CREATE address preparation uses the consumer's Quai-aware wallet or ContractFactory.
The SDK sequences deployment steps and coordinates account nonces; the consumer supplies
signing/fee policy, durable atomic storage and the actual vault/DAO consent executors.
Replacement inspection is implemented; actively signing a replacement remains an explicit
application decision. IPFS and realtime adapters own their transport credentials/connections.
The separate [QuaiVault SDK](docs/QUAIVAULT_INTEGRATION.md) can implement the vault authority
boundary without becoming a required DAOShips dependency. UI and CLI development remain
outside this SDK's scope.
