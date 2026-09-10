# SDK feature coverage

This audit compares the local Solidity contracts, app ABI artifacts, indexer schema/handlers, and SDK implementation. It establishes source and offline-test coverage, not successful deployment or execution on a live network. The package remains an alpha integration SDK; a callable ABI does not establish that every workflow has a dedicated preflight or outcome checker.

See [release readiness](RELEASE_READINESS.md) for the latest audit, validation results and
prioritized remaining release requirements. Earlier reports retain historical test counts.

Every public/external function declared by the 14 concrete DAOShips contracts is represented in the bundled ABI and generated `ContractClient` method types: DAOShip, both launchers, SharesERC20, LootERC20, Poster, and all eight navigators. Inherited token permit/voting methods, inherited navigator methods, and public storage/constant getters are included. External QuaiVault and QuaiVaultProxy ABI snapshots and the compiled IQuaiVaultFactory interface are also bundled (17 contract interfaces total). Overloaded methods use full Solidity signatures.

`check:source` now verifies this against current-source compiler output and AST selectors:
116 directly declared functions and 291 compiled methods across 14 contracts; the complete
17-interface maps contain 353 functions and 103 events. All 25 public tables receive SQL
schema parity checks. The [security audit](SECURITY_AUDIT.md) records the initial audit's
coverage and findings; the [final integration review](FINAL_INTEGRATION_REVIEW.md) records
the subsequent workflow comparison, added APIs and latest verification.

| Domain | SDK entry points | Offline verification |
| --- | --- | --- |
| Complete contract reads and transaction encoding | `ContractClient.read` / `encode`, `CONTRACT_ABIS`, generated `ContractMethods`; named outputs and exact bigint integers | `contracts.test.mjs`, `types.ts`; optional `check:source` compares every ABI artifact |
| DAO/member/treasury/configuration/capabilities | `DaoShipsChain.getDao`, `getMember`, `getTreasury`, `getCapabilities`, `getProposal`; generic client covers remaining getters and historical reads | `core-review.test.mjs`, `sdk.test.mjs` |
| Proposal lifecycle | `prepareSubmit`, `prepareSponsor`, `prepareVote`, `prepareVotes`, `prepareCancel`, `prepareProcess`; `encodeProposal`, `hashProposalData`; submit/process receipt helpers distinguish reverted actions from transaction success | `sdk.test.mjs`, `core-review.test.mjs`, `contracts.test.mjs` |
| Governance operations | Seven-field config codec; `encodeGovernanceCall`, `buildGovernanceAction`, `governanceRequiresProposal`; mint/burn, conversion, pause, permissions, guild tokens, permanent role locks | `governance.test.mjs`, `integration-review.test.mjs` |
| Tokens and ragequit | `DaoShipsToken`, `parseTokenAmount`, `formatTokenAmount`, `buildPermitTypedData`, `prepareRagequit`; generic Shares/Loot clients expose initialization, permit, ownership, checkpoints and transfer methods | `core-review.test.mjs`, `contracts.test.mjs`, `integration-review.test.mjs` |
| DAO launch and initialization | `encodeLaunchInitParams` / `decodeLaunchInitParams`; direct `encodeLaunchDAOShip`, combined existing-vault `encodeLaunchDAOShipWithVault`, new-vault `encodeLaunchDAOShipAndVault`; generic client exposes `setUp` / `initialize` and launcher prediction calls | `launch.test.mjs`, `integration-review.test.mjs` |
| Address prediction and deployment discovery | `predictDAOShipAddresses`, `predictLaunchAddress`, `vaultInitCodeHash`, `mineLaunchSalt`, `mineDAOShipSalts`; `discoverDeployment`, `verifyDeployment`, `minimalProxyImplementation` | `launch.test.mjs`, `deployments.test.mjs` |
| Vault setup and owner transactions | `ContractClient('QuaiVaultFactory')`: standalone factory creation/prediction; `ContractClient('QuaiVault')`: module enable/disable, delegatecall allowlist, owners/threshold/delay, transaction propose/approve/execute/revoke/cancel, message signing and signature checks | ABI/type coverage plus local actual QuaiVault proposal/approval/execution for DAO-required setup; broader multisig policy remains the vault SDK's responsibility |
| All eight navigators | `Navigator.read` / `encode` / `simulate`, typed constructor configs, `encodeNavigatorDeployment`, optional creation bytecodes, deployment receipt parser, onboarding quotes | `navigators.test.mjs`, `integration-review.test.mjs`; [detailed navigator matrix](coverage-navigators.md) |
| Metadata and allowlists | `buildPosterContent`, `validatePosterContent`, `encodePosterPost`, `buildDaoProfileUpdate`; eight supported tags; OpenZeppelin-compatible trees/proofs | `poster.test.mjs`, `final-profile-review.test.mjs`, `final-protocol-review.test.mjs`, fixed allowlist fixtures |
| Indexed data and catch-up | `DaoShipsIndexer.list` / `get` / `iterate`, typed tables/filter/order fields, DAO/proposal/member/vote/navigator/history conveniences, trust checks, checkpoint waiting | `indexer.test.mjs`, `sdk.test.mjs`, `integration-review.test.mjs` |
| Signing boundary and transaction recovery | `prepareCall`, `sendPreparedTransaction`, mandatory refresh/persistence callbacks, caller-owned signer, `confirmTransaction`, `resumeTransaction`, `parseContractEvents`, `decodeRevert` | `core-review.test.mjs`, `contracts.test.mjs`, `sdk.test.mjs` |
| Proposal inspection | `decodeProposal`, `verifyProposalDataHash`; bounded CALL-only parser and commitment verification | `final-proposal-review.test.mjs`, local Solidity governance execution |
| App queries and website counts | JSON paths, AND/OR groups, wildcard search, `count`, `listActiveMembers`, `listProposalSummaries`, `getNavigatorAllowlist` | `final-indexer-review.test.mjs`, negative consumer type checks |
| Vault revocation and activation requirements | `resolveVaultModulePredecessor`, `getNavigatorRequirements` | `final-protocol-review.test.mjs` |
| Deployment orchestration | `buildDAOShipLaunchPlan`, `buildNavigatorDeploymentPlan`, preflight, `advanceDeploymentWorkflow`, mined-receipt reconciliation and atomic checkpoints | `deployment-workflows.test.mjs`, source-verified real QuaiVault local workflow suite |
| Durable transaction recovery | `sendRecoverableTransaction`, nonce coordination, `inspectRecoveryTransaction`, bounded replacement scanning, versioned records | `transaction-recovery.test.mjs`; concurrency, restart, lost acknowledgements and reorg fault injection |
| Economic/token conveniences | `getRagequitQuote`, `quoteRagequit`, approval/reset/revocation plans, external permit-domain discovery | `conveniences.test.mjs`; local Solidity payout, signed permit and approval acceptance |
| Data integrations | `DaoShipsData`, `fetchIpfsAllowlist`, `publishAllowlist`, `watchIndexer`, `supabaseRealtimeAdapter` | `data-integrations.test.mjs`; chain-root checks, metadata identity, bounded joins, reconciliation and cleanup |
| Hosted Supabase connection | `connectDaoShipsSupabase`, bundled public project/key, explicit network and startup freshness/chain verification | `supabase.test.mjs`, isolated packed consumer; opt-in live public projection/count and sample-join checks |

## Convenience gaps: underlying calls are available

- Existing-vault launch plans sequence module and delegatecall setup with verified checkpoints. An application-supplied vault executor obtains owner authorization and executes those steps; a proposal receipt is insufficient. The [QuaiVault integration decision](QUAIVAULT_INTEGRATION.md) keeps multisig consensus in the separate vault SDK.
- Navigator plans sequence creation, the correct activation authority and optional treasury funding. Native CREATE address grinding and signing remain the caller's Quai-aware wallet responsibility. DAO proposal and vault executors must persist their intermediate consent transactions separately; the deployment checkpoint identifies the final execution transaction.
- Generic contract access supports more methods than the domain conveniences. Such calls receive ABI validation and can be simulated with `prepareCall`; they do not inherit specialized role, balance, retention, allowance or outcome validation automatically.
- `parseContractEvents` exposes launcher/vault/navigator events. Only selected workflows have dedicated receipt assertions; applications must verify their expected emitter, identifiers and business outcome for the rest.
- Token permit data is constructed but signing and submission remain caller-owned. Vault consensus coordination and custom contract signing formats use the wallet/provider integration.

## Functional capabilities not supplied by the SDK

- Deploying new singleton/launcher infrastructure is not an SDK workflow and their creation bytecodes are not bundled. This differs from launching DAO clones through existing factories and from the optional navigator creation artifacts.
- External ERC721/ERC1155 contracts, arbitrary application contracts and unsupported/custom navigators have no generated SDK-specific client. Their calls can be encoded with caller-supplied ABIs and passed to `prepareCall` or composed into proposal actions.
- IPFS allowlist upload and fetching are integrated through caller-selected adapters/gateways. The SDK verifies local trees and retrieved chain roots; it does not provide a pinning account, arbitrary media hosting or a complete IPFS DAG verifier. Wallet/key custody, chain/indexer hosting and durable storage infrastructure remain application services.
- Realtime subscriptions reconcile through precision-preserving HTTP queries, with a structural Supabase adapter and explicit reconnect/reorg hooks. The SDK does not provide an offline indexer replica or an atomic database snapshot. Metadata authentication/materialization still happens in the indexer.
- Current production deployment selection, bytecode identity/security attestation, live-chain acceptance tests, and automatic support for future contract versions remain unverified. Deployment graph consistency is checked only when a caller invokes discovery against its chosen RPC/launcher.

## Optional local contract execution

`npm run test:contracts` runs local contract, navigator and deployment workflow suites using the existing sibling contracts project's Hardhat installation and compiled artifacts. The deployment suite also requires source-current artifacts from the adjacent QuaiVault contracts checkout. It starts only an in-process Hardhat network with deterministic local accounts, loads a separate configuration without dotenv/public endpoints, verifies each artifact's compiler metadata source dependency closure and bytecode, and leaves the sibling checkouts unchanged.

The smoke test has passed for all three SDK launch encoders, direct CREATE2 prediction, governance initialization, proposal hashing, submission/voting/processing, and a governance-wrapped MultiSend mint that changes the actual SharesERC20 balance. DAOShip, launchers, tokens and MultiSend execute compiled Solidity; the vault factory and avatars are explicit test doubles. This validates local EVM behavior, not Quai RPC/signing/shard behavior or production QuaiVault owner consensus.

The core suite also verifies Shares/Loot permits and domain/replay/expiry rejection,
native/ERC20 ragequit payouts and burns, failed inner actions with rollback, and defeated
proposal closure. The [transaction audit](audit-transactions.md) records those checks.

The second suite deploys all eight real bundled navigator bytecodes and exercises SDK-driven
success and rejection paths against actual DAO/token clones. The
[protocol audit](audit-protocol.md) details those lifecycles and remaining transitions.

The deployment workflow suite uses actual QuaiVault implementation/proxy/factory artifacts.
It executes all three DAO launch plans and all eight navigator deployment/activation plans,
including owner proposal/approval/execution, Signal endorsement and treasury funding. This
is local EVM evidence; real Quai network/shard acceptance remains a separate release gate.

No CLI expansion is part of this SDK work. See [launch details](coverage-launch.md) and [navigator/metadata details](coverage-navigators.md) for protocol differences found in sibling projects and remaining integration requirements.
