# Orchard acceptance harness

This workspace harness exercises the DAOShips SDK on [Orchard, chain **15000**](https://docs.qu.ai/build/networks). It is
separate from the package's public API and is not a DAOShips product CLI. Importing the
SDK or running the ordinary tests does not contact a network or load wallet keys.

## Start with one funded account

From `daoships-sdk`:

```sh
npm run test:orchard:read            # live contract graph + testnet indexer readiness; no key
npm run test:indexer:hosted -- testnet # all 25 public table projections and sampled joins
cp .env.example .env
# Set ORCHARD_PRIVATE_KEY in .env when the funded account is available.
npm run test:orchard:smoke           # sends at most one zero-value self-transfer; costs gas
```

The smoke command uses the bundled Orchard addresses and spend bounds, verifies the
live contract graph and indexer, and exercises SDK transaction preparation, gas
estimation, signing, confirmation and recovery. It also checks stale-plan and signer
refusal paths without invoking the real signer. For the one real transfer it records
the hash, injects acknowledgement loss, and verifies recovery from persisted evidence.
It does not create a DAO or exercise a navigator business lifecycle.

Use a Cyprus-1 Quai account, as required by the SDK's supported address policy. A
normal gitignored `.env` is sufficient; there is no keystore or file-permission setup.
`ORCHARD_PRIVATE_KEY` is the owner key; the existing `ORCHARD_OWNER_PRIVATE_KEY` alias
also works. Environment variables override matching file variables. Optional
`--env-file PATH` selects another dotenv file; `--keys-file` remains an alias. Dotenv
comments, quotes, `export`, and unrelated variables are accepted as data. Shell
expressions are never evaluated, and keys are not printed or stored in test evidence.
The read/plan commands do not load `.env`.

Evidence defaults to `orchard-evidence/smoke/` (gitignored). Rerun with the same
directory to reconcile the same transaction without resending. `--evidence PATH`
selects another directory for an intentional fresh run. An unresolved broadcast
must be investigated before beginning another run with that account. `--config FILE`
overrides public addresses, timeouts and limits. Read and smoke modes do not require
the full suite's `contractsReviewed` flag: both verify the configured graph, and
smoke sends only to the supplied account. Full execute still requires that flag.

## Coverage expansion

Keep wallet-free reads separate from serial funded scenarios. A shared wallet's
nonce sequence and persisted scenario IDs must survive timeouts and restarts.

| Stage | Coverage | State |
| --- | --- | --- |
| Read readiness | Chain identity, deployed graph, Poster code, fresh testnet checkpoint, all public indexer projections | Passed live on 2026-09-11 |
| One-account smoke | Prepare/send/confirm a self-transfer; stale preparation, signer refusal, acknowledgement-loss recovery | Passed live on 2026-09-11, including process restart |
| Launch + activate | Three launch routes, all eight navigator activations, including Budget by a non-owner member | Passed live on 2026-09-11 |
| DAO lifecycle | Submit/vote/process, defeated proposals, governance configuration, cancel, action failure, membership and ragequit | Submit/vote/process, defeat and configuration passed; remaining business scenarios need expansion |
| Populated indexer | Match fixture DAO/member/navigator/proposal/vote/Poster rows to mined receipts | Passed live on 2026-09-11; fixture realtime invalidation/refetch remains separate |
| Navigator lifecycles | Onboarding/tribute/NFT claims, Signal polls, timelocks, vesting, budgets, recurring subscriptions | Local tests exist; live business scenarios remain to be added |

One funded account is enough to begin. The full harness needs a distinct funded
member for its non-owner Budget assertion. A later bootstrap can generate a second
test account and fund it from the supplied account; that funding path is not yet
implemented. Testnet timing is real: poll bounded state transitions and resume pending
scenarios instead of applying local-EVM time travel or automatically resending writes.

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
A stale or unavailable indexer prevents execution. Only `--smoke` and `--execute`
load wallets or broadcast; both require those same readiness checks before sending.

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

For the full suite, provide both keys in `.env` or the environment:

```dotenv
ORCHARD_OWNER_PRIVATE_KEY=0x<64 hexadecimal characters>
ORCHARD_MEMBER_PRIVATE_KEY=0x<64 different hexadecimal characters>
```

Use two distinct Cyprus-1 Quai-ledger test wallets. The default `.env` is relative to
the working directory; sibling repositories' files are not discovered. Keys and signed
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

New fixtures use a 180-second voting period. Submission is observed at one canonical
confirmation so voting can begin promptly. A bounded simulation poll waits only for
the contract's `DAOShipVotes: not yet determined` snapshot condition; other failures
stop execution. After voting, the submission is rechecked at the configured confirmation
depth before processing. Successful simulation cannot guarantee inclusion before a
voting deadline. A confirmed revert is reported as `TX_REVERTED`, distinct from an
unresolved submission.
The governance-state wait allows the fixture's voting/grace duration plus
`waitTimeoutMs`, since Orchard's chain clock can lag wall time. Transaction receipt
waits retain the configured `waitTimeoutMs` bound. A state-wait timeout resumes the
same proposal and never submits another vote.

Earlier sessions retain their original 60-second launch plans and receipts. The runner
extends that disposable DAO's window through a separate member governance proposal,
with durable `fixture/governance-window` evidence, before continuing activations.
The first window-update proposal still uses the old period and can itself expire.
It must be investigated and explicitly retried if that happens.

After the workflows finish, the runner waits for the public indexer to reach their
receipt blocks. It matches all three DAO rows and both members per DAO, all eight
navigator rows, and the activation proposals/votes to their transaction hashes and
business results. Signal also requires its vault-authored Poster record. Budget's
active module and Signal's endorsement are checked without inventing DAO permission
bits for either navigator. These checks run again when a completed session resumes.
For permissioned navigators, `NavigatorSet` updates the row's `tx_hash` to the grant
transaction; `deploy_block` retains the creation block. The checks verify both facts.

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

A defeated proposal requires a separate reviewed retry, rather than changing its
recorded intent. The runner accepts `governance-retry:<plan-id>:activate` evidence
identifying the prior proposal transaction ID/hash, proposal ID and a new attempt
number. A recorded failed vote also requires its canonical reverted hash. Prior
reviews remain in `history`. The runner authenticates the prior proposal, processes
it as defeated with empty calldata, and assigns new durable IDs to the new proposal,
vote and execution. It never generates this retry decision automatically.

A killed process can leave `session.lock` or a store `.lock`. Inspect the recorded PID
and prove the process has exited before removing the session lock. Store lock recovery
uses `recoverFileStoreLock(directory, exitedPid)` from the conformance reference backend,
under exclusive operator control. No timeout automatically releases an uncertain writer.

Read deadlines bound the acceptance operation; they cannot abort an underlying RPC
transport owned by the pinned provider. After provider cleanup, the standalone script
flushes its sanitized failure and exits so a failed transport cannot keep it alive.
Imported harness helpers do not terminate their caller's process.

## Read-only Orchard observation

On 2026-09-11 the earlier launcher failure was traced to the SDK's default read
sender. The public node returned `sender not an eoa` when `from` was the contract
address; the same getter succeeded without that sender. Current source uses the
zero address for default view calls (compatible with the pinned quais request types)
and preserves explicit caller overrides and transaction simulation senders. This
fix covers deployment discovery, DAO domain reads, `ContractClient` and `Navigator`.
This fix is included in `0.1.0-alpha.2`.

The updated wallet-free command passed the full configured deployment graph at
Cyprus-1 block **7,780,370**, with a healthy `testnet` checkpoint approximately
2.8 seconds old. A separate hosted-indexer run passed all 25 public projections
and sample joins in 67 requests. Fifteen tables were empty and their row behavior
remains unexercised. No keys were supplied and no transactions were sent.

The SDK's DAO configuration, treasury and SharesERC20 supply reads also passed
against an existing Orchard DAO (`0x00305ded5e7292eafdfc74167d1cc462ee24a6ef`),
with the configuration observed at block 7,780,387.

Historical observation, superseded by the diagnosis above:

On 2026-09-10 at approximately 22:26 UTC, an outbound read with a temporary copy of
the example configuration reported chain ID 15000. The example remains unreviewed
by default. The configured combined launcher
`0x0054Cb24fA412B2b276D5F73f4A7adC70f0f0Cbf` had 4,745 bytes of code at block
7,774,756 (`0xba8e94ff5439f3b68197449c962cea110149ee2b9f0110f62f6f7087f89a986d`).
However, deployment discovery failed with `CALL_EXCEPTION` and missing revert data
on `daoShipLauncher()` (`0x327d5135`). Code presence does not establish the configured
contract's expected identity. This failure led to the default-sender fix described above.

An independent hosted `testnet` check passed schema/network identity and the default
freshness policy: checkpoint 7,774,751, indexed at `2026-09-10T22:25:50.796+00:00`,
was approximately 1.3 seconds old and reported `is_syncing: false`. This observation
does not prove the indexer had reached the chain head. No keys were loaded and no
transactions were submitted during these checks.

## First funded smoke result

On 2026-09-11 the single-account smoke test completed using the supplied `.env`
account. The [zero-value self-transfer](https://orchard.quaiscan.io/tx/0x000f0022a4519b61544f491aedcb7bec94d6ef89cb08c1056cd89fea02d6400d)
mined in block **7,780,422**, status 1, nonce **6715**. The recorded recovery
observation had 22 confirmations. Actual gas was 21,000 at 1,200,000,000 wei per gas,
for **0.0000252 QUAI**. Stale-plan and signer-refusal checks passed; the deliberate
acknowledgement loss was recovered from durable evidence after a process restart,
without resending. Local evidence is in `orchard-evidence/smoke/`, with a readable
`report.json` summary.

The run exposed two pinned-quais integration issues:

- The harness used an ethers-style wallet method that does not exist in
  `quais@1.0.0-alpha.53`. Both runners now use `populateQuaiTransaction`. The first
  attempt failed before signing or broadcasting; its intact evidence and explicit
  no-send diagnosis are archived under `smoke-prebroadcast-api-failure/`.
- The dependency's transaction formatter parses the hexadecimal RPC nonce using
  decimal `parseInt`, turning `0x1a3b` into zero. The SDK's exported `DaoShipsProvider`
  converts exact RPC nonce quantities to decimal strings before formatting, including
  transactions embedded in full blocks. Malformed and unsafe integers are rejected.
  SDK recovery still validates the actual nonce; no comparison was bypassed.

The nonce fix is now available to consumers as `DaoShipsProvider` from `@daoships/sdk`;
the harness imports the same public implementation. The npm dependency remains pinned.
The provider and read-sender changes are included in `0.1.0-alpha.2`. Tests exercise the actual dependency
formatter. The [function audit](DAO_NAVIGATOR_FUNCTION_COVERAGE.md) records full local
DAO/navigator function coverage and the business scenarios still missing on Orchard.

The full suite's test token/NFT/proxy artifacts matched their compiler sources, and
the proxy's locally predicted address matched the live factory. The prepared public
configuration is `orchard-evidence/full.config.json`. Both funded keys are now set,
and the full run completed. Resume this recorded session with:

```sh
npm run test:orchard -- --execute --config orchard-evidence/full.config.json --evidence orchard-evidence/full
```

## Funded full-suite result

On 2026-09-11 the two-wallet suite completed all **three launch routes and eight
navigator activations**, including Budget deployed and activated by the member who
is not a vault owner. The full run recorded **63 transactions: 61 successful and two
reverted votes**, across blocks **7,780,484–7,780,918**. This excludes the earlier
single-account smoke transfer. Final workflow verification required two canonical
confirmations. The readable local report is `orchard-evidence/full/report.json`.
Actual fees totaled **0.0254071428 QUAI**, including the two reverted votes. A separate
completed-session restart revalidated the workflows, indexer and recovery result
without adding any transactions: attempts remained 63, and latest/pending nonces
remained 6772 for the owner and 1549 for the member. The report includes that proof.

The governance fixture is DAO `0x0069cD45da3Fc33682b6B0392ab8bE4c20D05266`, with
vault `0x000c25459aC3566F033D8fe2065205548C2ae76E`.

| Navigator | Verified deployment |
| --- | --- |
| Onboarder | `0x0059f376e8ddA2746a5928Ea2A6C8f2795dc245c` |
| ERC20Tribute | `0x004366F7409ABc78f2eB1e20a0575744a256a2C6` |
| NFTGated | `0x001090E8c9bF62045f383B32862AE98C3902115c` |
| Signal | `0x00625650b472933CbF7350a5a6F4A3482f5771E3` |
| Timelock | `0x004571030dE5d5AA70FdbC3EdC629Eb740dbB8fd` |
| Vesting | `0x003bBA58BaF64cCac840DfCc6C6764B20aaCfBdf` |
| Budget | `0x001E7E4C16D4bE9e20848707786cf81F60f5a1F7` |
| Subscription | `0x006c3Bf6622a206AD9755203c6E910C978305fE3` |

The public indexer matched all three DAOs, six member rows, eight navigators and
their activation proposals/votes, the Signal Poster endorsement, and three closed
defeated proposals. Stale-plan and signer-refusal checks passed. The injected lost
acknowledgement was recovered from a real self-transfer:
`0x007800036930a12110073df13af86caf3ec8d8978459001b4bbd524f95f07530`.

The run exposed several useful failure cases:

- Two early votes reverted with `NotVoting` after the original 60-second windows
  expired. Their receipts remain in the evidence; separate reviewed proposals
  eventually activated both navigators. Another Onboarder proposal expired after
  a prebroadcast same-timestamp snapshot failure. All three were closed as defeated.
- A member governance proposal extended the existing fixture to 180 seconds,
  preserving the original launch plans. Its successful execution hash is
  `0x007b0042ff0d8efcdb61df13c8c078dcc170341c43ab5b9bc916cea4d578dfe6`.
- Pinned-quais Poster log queries required explicit `nodeLocation: [0, 0]`.
- Signal's state-wait timeout and Subscription's receipt-wait timeout resumed their
  original proposals without resubmission. Voting waits now allow the full fixture
  period plus the configured timeout to accommodate chain-clock lag.

Current local validation passed **322 tests**, with no failures or skips. The packed
ESM/TypeScript consumer checks also passed. This live run used the updated local SDK
and harness; the fixes have not been published in the alpha package.

## What this does not establish

The offline regressions cover configuration rejection, native grinding and exact plan
verification, dotenv parsing, single-transfer spend bounds, durable evidence/reopen behavior, exclusive
session ownership, acknowledgement-loss recovery without resending, and mocked
read-only deployment/indexer readiness. The app's affected
metadata, navigator-validation and catalog suites passed 47 tests after artifact sync.
The funded runs establish native creation, governance activation, fixture indexer
rows, and self-transfer recovery. Navigator business lifecycles, replacement behavior
and finality still require their own live acceptance evidence.

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
