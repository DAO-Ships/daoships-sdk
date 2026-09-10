# Orchard acceptance harness

This workspace harness exercises the DAOShips SDK on Orchard, chain **15000**. It is
separate from the package's public API and is not a DAOShips product CLI. Importing the
SDK or running the ordinary tests does not contact a network or load wallet keys.

## Modes and prerequisites

```sh
node scripts/orchard-acceptance.mjs --plan
node scripts/orchard-acceptance.mjs --read --config /absolute/path/reviewed-orchard.json
node scripts/orchard-acceptance.mjs --execute \
  --config /absolute/path/reviewed-orchard.json \
  --keys-file /absolute/path/dedicated-test-wallets.env \
  --evidence /absolute/path/orchard-evidence
```

`--plan` is the default and prints the scenarios without network access. `--read` verifies
the live network, all reviewed launcher references and deployed prerequisites, Poster
code, and the hosted `testnet` checkpoint's identity and default five-minute freshness.
A stale or unavailable indexer prevents execution. `--execute` is the only mode that
loads wallets or broadcasts; it performs those same readiness checks first.

Start from `scripts/orchard/config.example.json`. Its cached Orchard addresses come
from the application's reviewed per-chain deployment table; they are not a claim that
this remains the intended release. Review the addresses and resource/spend limits,
set `contractsReviewed` to `true`, choose a fresh `saltStart`, and set the public
`vaultProxyArtifact` path relative to the copied configuration file. The factory's live
prediction must agree with those proxy creation bytes before an existing vault is created.
DAO launch preparation separately verifies new-vault predictions.

The example rejects transactions over its configured gas limit, per-gas fee ceiling,
native value limit and total attempt count. Limits are raw integers/wei. They are
upper bounds, not fee estimates or guarantees that the example values suit current
Orchard conditions. The fixture scenarios require no native value beyond transaction
fees. Each test wallet must already have enough Orchard funds for its transactions.
No faucet or account-funding operation is performed.

The wallet file must be a regular private file, mode `0600`, containing exactly:

```dotenv
ORCHARD_OWNER_PRIVATE_KEY=0x<64 hexadecimal characters>
ORCHARD_MEMBER_PRIVATE_KEY=0x<64 different hexadecimal characters>
```

Use two dedicated Cyprus-1 Quai-ledger test wallets and an evidence directory accessible
only to the test operator. Shell substitution, dotenv exports, arbitrary environment
variables and sibling `.env` discovery are deliberately unsupported. Keys and signed
transaction bytes are never written to evidence or logged. Public account identities,
unsigned plans, transaction hashes and outcomes are recorded. Provider errors are
reported as sanitized error codes, not raw request bodies or signer arguments.

## Scenarios and evidence

The runner creates and verifies all three launch routes: direct DAO launcher with an
existing vault, combined launcher with an existing vault, and atomic new DAO/vault.
Existing-vault fixtures have a single owner and zero delay; their module and MultiSend
bootstrap actions use actual owner proposal, approval and execution transactions.

It then deploys source-current test ERC20/ERC721 fixtures and all eight navigators using
native Quai CREATE. All navigator activations use DAO governance, including Budget's
vault self-call. Budget is deployed and activated by a DAO member who is not a vault
owner. Proposal submission, voting, waiting for Ready, processing, and final business
postconditions are handled by real SDK calls. Signal checks bounded on-chain Poster
history and authenticates the vault-authored complete endorsement set.

Every ordinary submission uses `sendRecoverableTransaction`; proposal, vote, owner
approval and processing transactions have separate durable IDs. The runner verifies
SDK recovery observations and canonical receipts before recording completion. Native
creation uses the pinned `quais` four-byte suffix algorithm, explicitly records the
nonce and suffix in its SDK plan, and reserves its account nonce in the same recovery
store. The full suffix is part of the reviewed creation calldata. It must not be
passed to `ContractFactory.deploy` for a second round of grinding.

Recovery acceptance first checks stale-plan rejection and signer refusal without
invoking the real wallet. It then sends at most one budgeted zero-value self-transfer,
records the returned hash in an independent durable journal, and deliberately drops
the acknowledgement. A fresh SDK observation recovers the mined result using only
the durable intent and hash. Restarts inspect that same intent without resending.
The report identifies the injected fault and whether the scenario resumed.

The reference file stores use atomic revision checks and fsynced writes, with an
exclusive harness session lock. This is a disposable acceptance backend on one host,
not a certification of a production database. See the adapter-conformance guide for
the separate multi-process and crash tests. Wallet accounts must not be used by another
application while this harness owns their nonce sequence.

An evidence directory is bound to its configuration and the two public wallet addresses.
Plans are persisted before execution; later runs reconstruct and authenticate them through
the SDK. Native creation additionally records its signed transaction's deterministic
hash before broadcasting. The workflow submission callback runs only after submission
is independently observed, before confirmation waits. A signed hash alone is not proof
that a transaction was broadcast.

Rerun the same command and evidence directory after interruption. Completed steps are
rechecked; pending hashes are reconciled. This runner can resume its own intermediate
approval/proposal transactions because every send checks its durable ID before attempting
another broadcast. Unknown submissions never authorize a resend. A crash after a signed
hash was recorded but before broadcasting intentionally remains unresolved until the
operator establishes what happened. Recovery of an unknown hash requires independent
transaction/block evidence and the SDK recovery APIs; do not delete its records or reset
its nonce cursor to force progress.

A killed process can leave `session.lock` or a store `.lock`. Inspect the recorded PID
and prove the process has exited before removing the session lock. Store lock recovery
uses `recoverFileStoreLock(directory, exitedPid)` from the conformance reference backend,
under exclusive operator control. No timeout automatically releases an uncertain writer.

Read deadlines bound the acceptance operation; they cannot abort an underlying RPC
transport owned by the pinned provider. After provider cleanup, the standalone script
flushes its sanitized failure and exits so a failed transport cannot keep it alive.
Imported harness helpers do not terminate their caller's process.

## Read-only Orchard observation

On 2026-09-10 at approximately 22:26 UTC, an outbound read with a temporary copy of
the example configuration reported chain ID 15000. The example remains unreviewed
by default. The configured combined launcher
`0x0054Cb24fA412B2b276D5F73f4A7adC70f0f0Cbf` had 4,745 bytes of code at block
7,774,756 (`0xba8e94ff5439f3b68197449c962cea110149ee2b9f0110f62f6f7087f89a986d`).
However, deployment discovery failed with `CALL_EXCEPTION` and missing revert data
on `daoShipLauncher()` (`0x327d5135`). Code presence does not establish the configured
contract's expected identity; resolving that deployment/read compatibility failure
is an outstanding gate before transaction acceptance.

An independent hosted `testnet` check passed schema/network identity and the default
freshness policy: checkpoint 7,774,751, indexed at `2026-09-10T22:25:50.796+00:00`,
was approximately 1.3 seconds old and reported `is_syncing: false`. This observation
does not prove the indexer had reached the chain head. No keys were loaded and no
transactions were submitted during these checks.

## What this does not establish

The offline regressions cover configuration rejection, native grinding and exact plan
verification, secure wallet-file parsing, durable evidence/reopen behavior, exclusive
session ownership, acknowledgement-loss recovery without resending, and mocked
read-only deployment/indexer readiness. The app's affected
metadata, navigator-validation and catalog suites passed 47 tests after artifact sync.
No private test wallet was available for this implementation, so **a successful live
transaction run has not been recorded**. Actual native creation, mined governance,
injected RPC-loss recovery, replacement behavior and finality remain live acceptance requirements.

The ordinary three local Solidity suites remain independent acceptance evidence. A
successful Orchard run does not prove all navigator business lifecycles, all indexer
rows/realtime delivery, transaction replacement races, provider diversity, production
storage durability, or chain finality. Configured confirmation depth is a canonical
zone-block observation. Use the recorded transaction evidence and separate fault/
replacement scenarios to assess the specific release claim.

## Application artifact parity

```sh
node scripts/sync-app-navigators.mjs --check
node scripts/sync-app-navigators.mjs --write
```

The script first verifies the SDK's eight creation artifacts against current compiler
inputs and output. It then compares or synchronizes the app's bytecode copies. This
review updated Onboarder, ERC20Tribute, NFTGated and Signal; the other four already
matched. The app's expected metadata CID fixtures were reviewed and updated alongside
those artifacts. Run the app's bytecode metadata tests after future synchronization.
This establishes repository artifact parity, not the versions already deployed on-chain.
