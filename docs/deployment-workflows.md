# DAO and navigator deployment workflows

`buildDAOShipLaunchPlan` and `buildNavigatorDeploymentPlan` create deeply frozen, deterministic plans containing concrete unsigned transactions, contract predictions, activation calls, dependencies and stable step IDs. Every asynchronous entry point reconstructs the domain plan and rejects inconsistent derived fields. Persist application inputs with bigint-aware serialization and reconstruct plans on restart; ordinary `JSON.stringify` does not serialize bigint fields.

## DAO launch routes

- `direct`: call `DAOShipLauncher.launchDAOShip`; CREATE2 clone salts use the initiating account as sender. Follow with separate vault authorization steps for `enableModule(daoShip)` and `addDelegatecallTarget(multisend)`.
- `existing-vault`: call `DAOShipAndVaultLauncher.launchDAOShipWithVault`; clone predictions use the combined launcher as sender. The same two owner-authorized vault steps follow.
- `new-vault`: call `launchDAOShipAndVault`; predict DAO, shares, loot and the initialized QuaiVault proxy. Supply the reviewed proxy creation bytecode, deployment singleton addresses, owner list, threshold and salt. The launcher atomically enables the DAO module and MultiSend delegatecall target. Proxy constructor hashing is tested against the actual adjacent QuaiVault contracts, including their sender-prefixed CREATE2 salt.

The default address policy requires Cyprus-1 Quai addresses, including every prediction. Use the existing salt-mining helpers first. Explicit `addressPolicy: 'evm'` supports local EVM acceptance tests. New vaults permit 1–20 distinct owners; the threshold must fit the actual owner set. The SDK does not choose owners or authorize their signatures.

`prepareDAOShipLaunch(plan, provider)` rereads launcher references, prerequisite code, predicted address vacancies and the factory's wallet prediction, then simulates the exact launch at one block. It checks the block and chain again before returning a `PreparedTransaction`. Reprepare close to submission: simulation cannot lock chain state or guarantee success after a competing transaction.

`assertDAOShipLaunchReceipt` checks source-address-filtered factory events. `verifyDeploymentWorkflowStep` additionally fetches the authoritative receipt and exact transaction, checks canonical block identity and chain, and reads deployed DAO/token/governance/vault postconditions. Existing vault setup is complete only after the required on-chain permission is enabled. A successful vault proposal transaction alone is insufficient.

## Navigator deployment and activation

Supply the selected canonical constructor config and creation bytecode, plus the final CREATE address from the caller's Quai-aware wallet/nonce/grinding implementation. The SDK validates and encodes the constructor; the `creation` executor owns native CREATE preparation and submission. Before creation it checks DAO/vault identity and that the predicted address is empty. The deployment receipt must come from the expected creation transaction and emit the expected navigator identity and metadata.

| Navigator | Activation |
| --- | --- |
| Onboarder, ERC20Tribute, NFTGated, Vesting, Subscription | DAO governance grants manager permission |
| Timelock | DAO governance grants governor permission |
| Budget | DAO governance executes a vault self-call to enable the navigator as a module |
| Signal | DAO governance posts the complete endorsed navigator set through Poster |

DAO activation steps expose both the exact action calls and their encoded `proposalData`. Executors own proposal submission, sponsorship/offering where applicable, voting, waiting through applicable periods, and processing. Verification requires the processed proposal hash to match that action data, successful action execution and the expected resulting permission. The SDK does not bypass governance or infer that the caller controls it.

All eight navigator activation steps use the `dao-governance` executor. Budget follows the
existing app's `budgetProposals.buildEnableModuleAction` pattern: encode
`enableModule(navigator)` targeting the vault and include that CALL in the DAO proposal.
`DAOShip.processProposal` runs MultiSend in the vault context, so the inner vault call
satisfies `onlySelf`. Do not wrap this vault call in `DAOShip.executeAsGovernance`; that
wrapper is for calls which must execute as the DAO itself. A DAO member can activate Budget
without being a vault owner. Owner consent remains necessary only for existing-vault
bootstrap in these deployment workflows.

If the exact Budget module is already enabled, preparation returns `alreadySatisfied`
and the runner records a checked state observation without submitting another proposal.
This establishes the current permission, not who granted it. Resume rechecks that permission
and stops if it has been revoked. A submitted activation still requires the exact successful
DAO execution receipt; a vault-owner receipt or proposal-submission receipt cannot replace it.

Budget plans created before this routing correction have a different plan ID. Rebuild and
review the plan from its original inputs; do not relabel or copy old checkpoints into it.
Resolve any pending transactions from the old workflow before starting a new one.

Signal requires `signalEndorsement.currentNavigators`, the complete original list, and `poster`. It appends the navigator. Before its activation executor runs, `verifyCurrentSignalEndorsement(plan, 'before-activation')` must affirm that the original list still matches caller-authenticated current Poster history/indexer data. Resuming a completed Signal activation requires the callback with `'after-activation'` to affirm that the resulting complete list remains current. The SDK bounds callback time but cannot authenticate an arbitrary caller's indexer or eliminate races during a later governance vote. An application must refresh/review its proposal when the complete set changes.

Optional `treasuryFunding: { token, amount }` creates a separate exact-amount transfer from `from` to the DAO vault after activation; zero token address means native QUAI. ERC20 funding requires the matching emitted transfer, and native funding checks exact transaction sender/recipient/value. Token units and the decision to fund remain explicit caller inputs.

## Durable sequencing and recovery

`advanceDeploymentWorkflow(plan, store, executors, provider, options?)` executes or reconciles **one** unfinished step per invocation. Supply executors keyed by `transaction`, `creation`, `dao-governance` and/or `vault`. Each executor receives the immutable plan/step and `{ id, prepared, onSubmitted }`. The stable ID is `${plan.id}:${step.id}`.

The store implements `load(planId)` and **atomic, cross-process** `compareAndSwap(planId, expectedRevision, checkpoint)`. `expectedRevision: null` creates a checkpoint only if none exists. A database transaction/conditional write can implement this contract. A plain asynchronous read followed by write is insufficient. The SDK persists `submitting` before granting an executor permission to act, then persists the transaction hash through `onSubmitted(hash)` immediately after broadcast, before waiting. It marks the step `verified` only after authoritative receipt/postcondition checks. Competing workers cannot both win the submission claim.

Use `sendRecoverableTransaction` for executor-internal ordinary transactions and stable IDs derived from the supplied step ID. A vault or governance executor may need several separate transactions: persist each proposal, approval and final execution under distinct recovery IDs. Call the workflow's `onSubmitted` for the **final business execution transaction**, not its proposal/approval transaction. Creation transactions need the caller's Quai-aware creation executor and corresponding durable wallet/nonce recovery.

If submission acknowledgment is lost, `submitting` blocks automatic retry. Once the transaction is mined, call:

```ts
await reconcileDeploymentWorkflowStep(plan, store, 'create', recoveredHash, provider);
```

This verifies the actual receipt and domain intent, rechecks earlier verified prerequisites and atomically records completion. An unknown or pending receipt cannot advance state. A known submitted hash can be replaced only with explicit `{ replacementOf: originalHash }`; original and replacement must have identical sender, nonce, chain, recipient, data and value, followed by successful domain verification. Cancellation or changed-intent replacements cannot complete the deployment step. Wallet discovery of an unknown hash remains caller-owned; the SDK never guesses or resends.

A resume revalidates saved receipts against the canonical chain and checks current role/module/endorsement prerequisites before proceeding. Missing receipts and revoked permissions stop progress. Checkpoints with unknown steps, broken dependency order or unsupported states are rejected. A completed workflow's token/governance initialization is verified at its launch receipt block: later legitimate DAO changes do not rewrite the launch history.

## Evidence and limits

`test/deployment-workflows.test.mjs` covers plan immutability, all launch/activation route encodings, provider bounds/cancellation/deadlines, deployment reference drift, occupied predictions, exact receipt/transaction identity, source events and postconditions, checkpoint validation, atomic concurrent claims, uncertain submission, mined recovery, repriced recovery, stale Signal sets and caller mutation during asynchronous verification.

`scripts/local-deployment-workflow.cjs` executes all three launch plans and all eight navigator creation/activation plans on Hardhat with current DAOShips bytecode and **actual QuaiVault factory/implementation/proxy artifacts**. It exercises vault owner proposal, explicit approval and execution; rejects proposal-only completion; verifies new-vault CREATE2 predictions, Signal Poster execution, Budget module enablement and ERC20 funding. Artifacts are checked against compiler metadata and current dependency source before deployment. The suite reads adjacent `../../QUAI-VAULT/quaivault-contracts` (override `DAOSHIPS_TEST_VAULT_CONTRACTS`) and requires its built artifacts/dependencies.

This is local EVM acceptance, not live Quai transaction/grinding/finality validation. It does not prove every navigator business lifecycle through this runner; the separate local navigator suite tests representative operational flows. The SDK remains dependent on honest provider results, correctly atomic persistence, caller-authorized governance/vault executors and current reviewed contract deployments. Existing executors must account for real quorum, sponsorship, timelocks, owner changes and transaction recovery; the SDK does not silently collapse these into a successful proposal receipt.

## Receipt confirmation policy

`verifyDeploymentWorkflowStep`, `advanceDeploymentWorkflow` and
`reconcileDeploymentWorkflowStep` accept `confirmations` (1–10000, default 1).
This is the required canonical Cyprus-1 block depth for a mined receipt, not a
Quai finality guarantee. Insufficient depth returns `TX_PENDING`; the submitted
checkpoint remains available for later reconciliation and no transaction is resent.
Use the same policy on each advance and reconciliation. Resume revalidates prior
receipts against the supplied policy. Permission-only `alreadySatisfied` steps
remain current state observations, with permission rechecked before dependencies.

## Native Quai creation suffix

Pinned `quais.ContractFactory.grindContractAddress` appends a four-byte suffix to the
encoded constructor payload. For such deployments, provide
`quaiCreation: { nonce, salt }` when building the navigator workflow. The builder
includes the exact suffix in `creationData`, derives the expected native address
using the pinned factory algorithm, and rejects a mismatch. Preparation checks the
current pending nonce; receipt verification checks the actual transaction nonce.
This option requires the Cyprus-1 address policy. Send those finalized bytes exactly;
calling `ContractFactory.deploy` afterward would append another suffix and change the
reviewed payload. The Orchard harness demonstrates the complete integration.
