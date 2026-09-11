# Protocol-domain audit

Audit date: 2026-09-09. Reviewed the SDK launch, CREATE2, governance, deployment discovery, all eight navigators, Poster and allowlist modules against sibling Solidity sources, ABI/build artifacts and the indexer's Poster validators. Changes affect the SDK only.

The [2026-09-11 function audit](DAO_NAVIGATOR_FUNCTION_COVERAGE.md) supersedes the
function-coverage gaps below: every DAO/navigator function now executes locally through
the SDK. This earlier report retains historical behavior and boundary findings.

## Findings corrected

| Finding | Effect before correction | Correction and regression evidence |
| --- | --- | --- |
| Sparse governance flag arrays | JavaScript holes skipped the boolean validator and could become `false` during ABI encoding, disabling a guild token rather than rejecting malformed input. | Governance calls now pass the shared recursive ABI normalizer; malformed parallel arrays are bounded and rejected. Launch initialization and vault owner arrays reject holes/accessors before processing. |
| Unbounded Poster work before the byte limit | Oversized content could be traversed, parsed as a bigint or hashed as a Merkle dump before the final 16 KiB check. | A bounded plain-JSON pass and actual serialized UTF-8 size check now precede schema-specific processing. Oversized arrays/strings, cyclic nesting and out-of-range bigint values are rejected. |
| Poster payload silently changed structurally | Blocked properties were discarded, custom object instances could serialize into unrelated empty objects, sparse arrays became nulls and nested unsupported navigator fields were accepted although the indexer drops them. | Reject blocked properties, accessors, nonplain objects, nonfinite numbers, hidden/symbol properties, sparse arrays and unsupported navigator entry fields. Accessor tests verify the getter is never called. Existing documented control-character normalization and omission of optional undefined object fields remain. |
| Malformed profile links passed SDK validation | A prefix such as `https://[` passed the regex although it is not a valid URL. | Profile links now use URL parsing with allowed protocol and host checks, matching the other URL fields. |
| Unbounded and noncanonical allowlists | Tree/proof processing had no aggregate input limit; a mathematically valid dump could claim duplicate members; sparse proof entries were silently skipped by array reduction. | Exported `ALLOWLIST_LIMITS` bounds trees at 10,000 members, text input at 2,000,000 characters and proofs at 256 nodes. Duplicate members and sparse proof nodes are rejected. Mutations are tested across 1, 2, 3, 5, 8 and 17-leaf trees. |
| Navigator ABI validation differed from generic contract calls | Sparse inputs and overly large argument collections could reach ABI encoding; ambiguous methods surfaced dependency-specific errors. | Navigator constructors, reads and writes share recursive ABI normalization. Unknown/ambiguous methods produce `INVALID_ARGUMENT`. Constructor accessors are rejected without invocation. Poll start-plus-duration overflow is rejected locally. |
| Onboarder quotes rejected a valid complete deployment config | The quote helper validated every object value as a bigint, including `daoShip`, name and description supplied by structurally compatible TypeScript callers. | Validate the six pricing fields specifically, and reject missing fields. The local EVM test compares the SDK quote with actual minted shares/loot and treasury receipt/refund behavior. |
| Simulation forwarded operation metadata into RPC requests | The navigator's descriptive `operation` field was spread into the provider request. | Simulation forwards only `to`, `data`, `value`, `from` and optional `blockTag`; a regression checks the exact keys. |
| Salt mining could block cancellation with a large progress interval | An arbitrarily large `yieldEvery` prevented the event loop from delivering cancellation. | Mining yields at least every 128 unsuccessful attempts while retaining the requested progress callback interval. A deterministic nonmatching salt interval tests timer-delivered cancellation with `Number.MAX_SAFE_INTEGER` as the progress interval. |

The resource limits are SDK protections for untrusted inputs, not Solidity protocol limits. Applications needing larger allowlists must use a separately reviewed Merkle implementation and can still encode protocol calls through the contract surface. Treat arbitrary JavaScript proxies or externally executable callbacks as application code; these validations are not a JavaScript sandbox.

## Executable integration evidence

`scripts/local-navigators-smoke.cjs` uses an isolated in-process Hardhat EVM, without dotenv or a public RPC. It checks each deployment artifact against its compiler output and current source dependency closure, then checks every bundled navigator creation bytecode against that artifact. The eight navigators are deployed using SDK constructor encoders and bundled bytecode, and deployment receipts are decoded with the SDK.

| Navigator | Behavior exercised against Solidity |
| --- | --- |
| Onboarder | Fixed-price minting, treasury payment and remainder refund; insufficient tribute; pause/unpause; multiplier pricing; SDK-built Merkle proof accepted on-chain, wrong account/proof and proofless restricted onboarding rejected. |
| ERC20Tribute | Approved ERC20 tribute payment; SDK quote matches actual treasury token balance and member share mint; SDK EIP-2612 typed data signed with a real account, consumed in onboarding without prior allowance, nonce increment and replay rejection. |
| NFTGated | NFT ownership rejection, successful claim/mint, duplicate-token rejection. |
| Signal | Creator threshold rejection, poll creation, weighted vote, duplicate vote rejection, ended status and late vote rejection. |
| Timelock | Avatar-only queue, early execution rejection, wrong-config-hash rejection, matured config execution, replay rejection, cancelled change remains unexecutable after its delay. |
| Vesting | Avatar-only creation, cliff enforcement, authorized beneficiary claim, unauthorized caller and repeated claim rejection; partial loot vesting frozen at revocation, repeated revocation rejected, earned claims remain available during pause. |
| Budget | Avatar-created budget, rejection before explicit treasury module grant, manager authorization, exact native recipient payment, period allowance, cancellation; ERC20 batch recipients, periodic rollover, lifetime ceiling and exhaustion. Failed pre-grant disbursement preserves budget balance. |
| Subscription | Exact native payment, ERC20 payment, extension of paid-through time, rejection of premature collection, delinquency, share burn, repeat collection rejection; conversion to loot, exact 10% collector reward, pause/unpause and duplicate-tolerant batch re-enrollment. |

The environment uses real DAOShip, SharesERC20 and LootERC20 clones. MockAvatar supplies treasury module authorization and execution; MockERC20, MockERC20Permit and MockERC721 supply test assets. A test module allows the owner to send avatar-origin calls. New manager permissions are granted through actual SDK-encoded proposals, voting and processing; direct avatar grants outside proposal execution are explicitly rejected. For Merkle onboarding, Hardhat impersonates a funded Cyprus-1-shaped EOA, allowing SDK address validation and Solidity membership verification to be exercised together. This is not evidence of production QuaiVault owner consent or Quai shard routing.

`test/audit-protocol.test.mjs` adds 14 regression cases for the findings above, together with unknown governance discriminants, noncanonical governance padding, arithmetic boundaries, Merkle corruption and mining limits. Existing launch/governance/Poster/deployment/navigator tests continue to apply. ABI enumeration tests demonstrate method availability and encoding compatibility; they do not establish complete workflow coverage.

Run from the SDK directory:

```sh
npm test
npm run test:contracts
npm run check:source
```

## Remaining coverage and acceptance gaps

- Production QuaiVault creation, owner signatures/thresholds, module consent, delegatecall allowlisting and min-delay behavior are not validated by the mock-vault integration tests. Existing-vault launch consent must be established independently by the integrating wallet/application.
- The local navigator suite covers representative happy and rejection paths, not every state transition. ERC20 fee-on-transfer behavior and permit front-run/fallback handling; NFT transfer/claim races; Signal future starts/cancellation/delegation changes; Timelock pause/emergency cancellation/expiry; Vesting multiple claims before revocation; Budget manager rotation and transfer-failure batch rollback; and exact Subscription grace-boundary paths still need SDK-driven execution coverage. Some have sibling contract tests; that is not a substitute for SDK integration tests.
- Governance role locks, sponsor retention floors, ragequit, delegation, clone-token permit signing, failed proposal recovery and all launch collision/consent failure paths are not all exercised by these domain scripts. Their availability in a typed ABI does not make them fully tested workflows.
- RPC discovery verifies reference-graph consistency and nonempty code at a stable block. It does not attest trusted runtime hashes, audit status or which deployment an operator should consider current. A malicious but internally consistent contract graph is outside that assurance.
- No live Quai shard execution, hosted indexer acceptance, hardware wallet acceptance or chain reorganization integration was run. CREATE2 arithmetic and local EVM behavior do not prove Quai-specific address routing or public deployment validity.
- Poster validation verifies content structure and inline Merkle consistency. It does not establish posting authority, DAO membership, sanctioned navigator identity, poll creator identity, current poll option count or an IPFS pointer's content availability. Those remain chain/indexer/application checks.
- Arithmetic quotes model integer math only. They do not account for changing caps, pause/expiry state, balances, allowance, malicious tokens or concurrent transactions; simulate the exact caller/value against the target deployment before signing.

No claim of complete security or exhaustive protocol workflow coverage follows from this audit. The package should retain its alpha status until the acceptance gaps relevant to its supported integration guarantees are closed.
