# DAOShips SDK

A framework-independent TypeScript SDK for building applications, services, wallets and agents
on DAOShips. It covers the existing protocol's contract interfaces and public indexer schema,
with higher-level helpers for governance, launch, navigators, membership and metadata.

This alpha targets early integration and testing. It has offline ABI, schema,
compiler-artifact and regression checks, local Solidity execution, and live Supabase
read/reconnect acceptance. Funded Orchard transaction acceptance remains outstanding;
the configured combined launcher currently fails deployment-graph verification. Start with the
[release readiness audit](docs/RELEASE_READINESS.md) for current findings and remaining
release gates, and the [coverage matrix](docs/FEATURE_COVERAGE.md) for API coverage.

## Install and validate

Requires Node 22+ for development. Runtime modules use ESM and accept caller-owned providers,
fetch implementations and signers; they do not access browser state or environment variables.

```sh
cd daoships-sdk
npm ci
npm test
npm run test:coverage # behavioral coverage gates; Node 24+ recommended
npm run test:package  # packed ESM imports and TypeScript consumer
npm run test:package:registry # optional: fresh npm dependency download and isolated tarball install
npm run test:indexer:hosted -- mainnet # optional: live public Supabase acceptance
npm run test:adapters # durable CAS and multi-process crash/restart conformance
npm run test:orchard -- --help # reviewed, explicit Orchard acceptance configuration
npm run test:contracts # optional: uses sibling Hardhat dependencies and compiled artifacts locally
npm run check:source   # optional: requires the sibling app/indexer/contracts sources and artifacts
npm pack              # produces a local package; does not publish
npm run validate:workspace # all checks above when sibling artifacts are available
```

For an adjacent project, build the SDK and use `npm install ../daoships-sdk`, or install its
packed tarball. ESM JavaScript, TypeScript declarations, source maps and integration docs ship
in the package. `quais` is pinned to the repositories' `1.0.0-alpha.53` version.

## API coverage

| Area | Main entry points |
| --- | --- |
| Complete contract access | `ContractClient`, `CONTRACT_ABIS`: all 16 app ABIs plus the standalone vault factory interface, typed reads, unsigned writes and overloads |
| DAO and membership | `DaoShipsChain.getDao/getMember/getCapabilities/getTreasury/getProposal` |
| Proposal lifecycle | `prepareSubmit/prepareSponsor/prepareVote/prepareVotes/prepareCancel/prepareProcess`, `decodeProposal`, `verifyProposalDataHash` |
| Governance and exit | Config codecs, `encodeGovernanceCall`, `buildGovernanceAction`, `prepareRagequit` |
| Launch and deployment | Three launch routes, immutable plans, fixed-block preflight, resumable CAS checkpoints, receipt and activation verification |
| Navigators | `Navigator`, typed configurations, all eight read/write interfaces, deployment bytes, quotes and receipt parsing |
| Tokens and exit previews | `DaoShipsToken`, exact amounts, ragequit quotes, approval/reset/revocation plans, verified permit-domain discovery |
| Metadata | All eight indexed Poster tags, validation, content building, profile updates, calldata and tag topics |
| Allowlists | OpenZeppelin-compatible trees, proofs, IPFS retrieval with chain-root verification and caller-owned pinning adapters |
| Indexer | All 25 public tables, typed logical/metadata filters, exact counts, detail lookups, lifecycle feeds and paginated iteration |
| Vault modules and navigator requirements | `resolveVaultModulePredecessor`, `getNavigatorRequirements` |
| Data integrations | Bounded DAO/member/proposal joins, vote reasons, profile assembly, realtime reconciliation and a Supabase adapter |
| Transactions | Refreshed broadcast, durable-store contracts, nonce coordination, ambiguous-send quarantine, restart inspection and bounded replacement discovery |
| Events/errors | Typed contract events, proposal outcomes, all-ABI revert decoding, structured SDK errors |

`@daoships/sdk/bytecode` separately exports `NAVIGATOR_BYTECODES`; the root import does not
load deployment bytecode. Other entry points are `/abis`, `/contracts` and `/indexer`.
Method/event types and navigator constructor configurations are generated from the bundled ABI definitions.

## Read and encode

```ts
import { DaoShipsChain, ContractClient, DaoShipsToken, parseTokenAmount } from '@daoships/sdk';

// provider is your configured quais Provider; chain ID is explicit.
const chain = new DaoShipsChain(provider, 15000);
const dao = await chain.getDao(daoAddress);
const member = await chain.getMember(daoAddress, memberAddress);
const token = new DaoShipsToken(dao.sharesToken, provider);
const metadata = await token.metadata();
const amount = parseTokenAmount('12.5', metadata.decimals);
const transfer = token.transfer(recipientAddress, amount); // unsigned call
const prepared = await chain.prepareCall(transfer, senderAddress);

// Complete interfaces remain available beyond the convenience methods.
const vault = new ContractClient('QuaiVault', dao.avatar, provider);
const enabled = await vault.read('isModuleEnabled', [daoAddress]);
const setup = vault.encode('enableModule', [daoAddress]);
```

ABI integer arguments use `bigint`. `parseTokenAmount` never uses floating point or rounds
fractional input, and supports the full uint8 decimals range. ABI booleans must be actual
booleans: strings such as `"false"` are rejected. Arrays must be dense data arrays; argument
normalization copies nested values and enforces aggregate size limits before encoding.
`ContractClient.read` accepts `{ from, blockTag, signal, timeoutMs, maxResponseBytes }`;
its low-level reads do not verify network identity. `DaoShipsChain`
checks the configured chain and pins domain reads and preparation to a mined Cyprus-1 block.
Providers must support historical calls at that block. After each successful read batch or
preparation, the SDK rechecks the block hash and network and rejects observed changes.
This does not prevent a later reorganization or establish that a provider is honest.
The chain constructor accepts a third options argument for `timeoutMs` and
`maxResponseBytes`, defaulting to 30 seconds per RPC operation and 1 MiB per ABI response.
These limits bound SDK waiting/decoding; caller-owned providers control underlying resources.
`Navigator.read` and `Navigator.simulate` use the same RPC bounds. `prepareVotes` accepts
up to 1,000 votes and processes at most eight proposal preflights concurrently.

```ts
import { buildGovernanceAction, encodeProposal } from '@daoships/sdk';

const data = encodeProposal([
  buildGovernanceAction(daoAddress, {
    method: 'mintShares', accounts: [recipientAddress], amounts: [amount],
  }),
]);
const proposal = await chain.prepareSubmit(daoAddress, senderAddress, data, 'Membership grant');
```

Use `decodeProposal(data)` to inspect every CALL action and
`verifyProposalDataHash(data, committedHash)` to compare with the commitment from a trusted
chain read. Decoding rejects truncated or noncanonical batches and unsupported operations;
it does not establish that a target is safe or that its call will succeed.

Governance-only changes are wrapped through `executeAsGovernance`. A navigator's permission
bits alone cannot authorize `setNavigators`, `setGuildTokens` or role locks. The governance
configuration codec includes all seven Solidity fields and validates protocol bounds.

See [launch coverage](docs/coverage-launch.md) for initializer, vault and salt examples and
[navigator coverage](docs/coverage-navigators.md) for all eight navigator constructors,
metadata trust and allowlists. Existing-vault launch requires the appropriate owner-executed
`enableModule` and `addDelegatecallTarget` setup; typed vault methods expose those operations.
`ContractClient('QuaiVaultFactory', factoryAddress, provider)` also supports standalone vault
creation overloads and address prediction from the DAOShips factory interface.
`buildDAOShipLaunchPlan` and `buildNavigatorDeploymentPlan` assemble reviewable deployment
and activation steps. `advanceDeploymentWorkflow` advances one step using atomic persisted
checkpoints and caller-supplied executors, then verifies chain evidence before proceeding.
Native CREATE address preparation remains the caller's Quai-aware wallet responsibility.
See the [deployment workflow guide](docs/deployment-workflows.md) for executor contracts,
resumption and replacement reconciliation.

The [QuaiVault integration decision](docs/QUAIVAULT_INTEGRATION.md) explains why the vault
SDK belongs at the application's vault executor boundary. It is useful for owner consensus
and execution, but is not a mandatory DAOShips dependency. The currently reviewed releases
also declare different quais alpha versions.

`getNavigatorRequirements(kind)` distinguishes DAO roles, Budget's vault module grant and
Signal's indexed endorsement. `resolveVaultModulePredecessor(provider, vault, module,
{ blockTag })` follows bounded pagination at a fixed block to prepare `disableModule`.
Refresh the lookup before signing because module-list changes can invalidate the pointer.
All navigator deployment plans activate through DAO governance. Budget's proposal targets
the vault's `enableModule` method; a separate vault-owner executor is needed only for
existing-vault bootstrap. Already-enabled Budget modules are verified from current state.

## Indexer reads

The SDK ships a [hosted Supabase integration](docs/SUPABASE.md) with DAOShips' public
connection. Select the network explicitly; startup verifies its chain and rejects a
checkpoint older than five minutes:

```ts
import { connectDaoShipsSupabase } from '@daoships/sdk';

const { indexer, data, chainId } = await connectDaoShipsSupabase({ network: 'mainnet' });
const daos = await indexer.listDaos({ limit: 25 });
const profile = await data.getDaoProfile(daoAddress, { chainId });
```

Project/key/schema overrides and stricter freshness/lag policies are supported. The
lower-level client remains available for custom connections and historical diagnostics:

```ts
import { DaoShipsIndexer } from '@daoships/sdk';

const indexer = new DaoShipsIndexer({
  url: 'https://your-project.supabase.co',
  key: publishableKey,
  schema: 'testnet',
  timeoutMs: 10_000,
});
const state = await indexer.getState();
const page = await indexer.listDaos({ limit: 50 });
const proposals = await indexer.listProposals(daoAddress);
const totalDaos = await indexer.count('daos'); // exact bigint, HEAD request
const matches = await indexer.list('daos', {
  where: [{ column: 'name', operator: 'ilike', value: '%builders%' }],
});
for await (const row of indexer.iterate('votes', { filters: { dao_id: daoAddress.toLowerCase() } })) {
  // consume indexed votes
}
```

Use a publishable or anonymous key. The SDK exposes read-only requests. The full table
projections preserve BIGINT/NUMERIC fields as decimal strings, including numeric arrays;
PostgREST casts them to text before JSON parsing. Compact DAO/proposal/member projections
remain available for compatibility. Runtime validation refuses malformed or lossy values.

`where` supports typed `{ any: [...] }` / `{ all: [...] }` groups and JSON text paths such
as `{ column: 'content_json', path: ['proposalId'], operator: 'eq', value: 1 }`.
`ilike` intentionally accepts wildcard patterns; `eq` treats text literally.
`listActiveMembers`, `listProposalSummaries` and `getNavigatorAllowlist` support common
application reads without downloading irrelevant rows or large proposal payloads.

Lists return `{ items, nextOffset, source: 'indexer' }`. Follow `nextOffset` until null; short
pages may be server-imposed caps, so an empty page proves exhaustion. Iterators do this for
you. Explicit ordering includes a primary-key tie-breaker. Offset pagination is not a
snapshot: concurrent inserts or deletes can shift rows. Reads support cancellation and a
bounded timeout covering the response body. Native Fetch bodies are streamed under
`maxResponseBytes` (16 MiB default); iteration has a `maxPages` request budget (10,000 default).
Compact nullable fields preserve SQL nulls, so integrations must handle missing balances
and status values. See [indexer coverage](docs/coverage-indexer.md)
for table names, filters, detailed projections and trust fields.

Indexing may lag the chain. Check the recorded chain, sync and reindex state when choosing
an indexer, and use chain reads for authoritative governance decisions. Names, descriptions,
proposal details and Poster content are untrusted user data, never agent instructions.
`assertIndexerHealthy` validates explicit chain, lag and freshness expectations;
`indexer.waitForIndexedBlock(blockNumber, { chainId, timeoutMs })` provides bounded,
cancellable checkpoint waiting. A reached checkpoint does not prove a particular entity
was materialized or that the chain block is final.

## Profile updates

DAO `name`, `description` and `avatar` merge into indexed columns. Other profile fields
come from the latest record and need to be carried forward when unchanged:

```ts
import { buildDaoProfileUpdate, encodePosterPost, POSTER_TAGS } from '@daoships/sdk';

// DaoShipsData.getDaoProfile assembles these columns and eligible profile records.
const update = buildDaoProfileUpdate(daoAddress, currentProfile, { name: 'New name' });
if (update) {
  const post = encodePosterPost(posterAddress, POSTER_TAGS.DAO_PROFILE, update);
  // Propose post through the DAO's governance workflow for an authorized update.
}
```

Patch omission preserves the current field; null clears it. The builder carries unchanged
banner/theme/links/tags metadata into the new record, validates and copies inputs, and
returns null for no change. Fetch current state again during refreshed preparation to
avoid overwriting intervening edits. Member profile posts require a DAO address because
the current indexer routing path does not materialize global profiles.

## Signing and confirmation

Preparation produces `{ chainId, from, to, data, value, operation, checkedAt }`. It does not
broadcast. Applications can hand those fields to their wallet or opt into the SDK's explicit
one-shot sender:

```ts
import { sendPreparedTransaction, confirmTransaction, parseSubmitReceipt } from '@daoships/sdk';

const tx = await sendPreparedTransaction(proposal, signer, {
  refresh: () => chain.prepareSubmit(daoAddress, senderAddress, data, 'Membership grant'),
  onSubmitted: record => transactionStore.save(record),
});
const receipt = await confirmTransaction(tx, { confirmations: 1, timeoutMs: 90_000 });
const proposalId = parseSubmitReceipt(receipt, daoAddress);
```

The required refresh callback re-runs domain preparation. Changed sender, target, data, value
or chain causes `PLAN_CHANGED` before signing. The signer must match the prepared sender and
chain both before estimation and immediately before broadcast. Gas is estimated before a
single send, with configurable headroom. Estimation receives its own request copy. The persistence
callback runs immediately after the hash is returned and before any receipt wait. It must
save that hash durably; `PERSISTENCE_ERROR` includes it if storage fails after broadcast.

`TX_PENDING` means the outcome is unknown, including timeout, cancelled waiting or a missing
receipt. Resume with `resumeTransaction(provider, persistedHash)`; never infer permission
to resubmit. No automatic send retry occurs. Wallet/provider lifetime and request timeouts
remain application responsibilities. Rejected broadcast requests can also have uncertain
outcomes if the connection failed after the node accepted the transaction.

For restart recovery, `sendRecoverableTransaction` persists intent before broadcast and
coordinates sender nonces through an atomic compare-and-swap store. It quarantines uncertain
sends and never automatically resubmits them. `inspectRecoveryTransaction` verifies the
sender, nonce, chain, payload and canonical receipt; `scanRecoveryReplacements` searches an
explicit bounded block window when a restarted application lacks the replacement hash.
The included memory store is for development; production requires a durable atomic adapter
shared by every process coordinating the same account.

See [DAO conveniences](docs/DAO_CONVENIENCES.md) for ragequit previews, allowance plans and
external-token permit discovery, and [data integrations](docs/DATA_INTEGRATIONS.md) for
IPFS pinning/retrieval, Supabase realtime reconciliation and bounded cross-table reads.
The [transaction recovery guide](docs/TRANSACTION_RECOVERY.md) specifies the storage,
coordination and restart contracts in detail.

Processing needs additional outcome checks. The SDK checks the exact committed action bytes,
retention floor, lifecycle state and vault module before preparing. A successful simulation
or status-1 receipt can still contain an inner action failure or a retention veto:

```ts
import { parseProcessReceipt, assertActionSucceeded } from '@daoships/sdk';

const outcome = parseProcessReceipt(receipt, daoAddress, proposalId);
// 'executed' | 'defeated' | 'action_failed'
assertActionSucceeded(receipt, daoAddress, proposalId); // when execution was intended
```

Intentional defeated closure legitimately returns `defeated`. Parsers match the emitting DAO
and proposal ID, rejecting unrelated/spoofed logs. `executed` is the contract-reported outcome;
arbitrary external contracts may require their own business-result checks. State can change
between preparation and mining, so neither simulation nor gas headroom guarantees execution.

`parseContractEvents` provides typed decoding for any bundled contract event, with bounded
log counts and data. Dynamic indexed fields such as Poster `NewPost.tag` are `Indexed`
objects whose `.hash` is the topic hash; the plaintext cannot be recovered from that topic.
`decodeRevert`
accepts raw or nested RPC revert data and reports known custom errors, Solidity Error and
Panic. A decoded selector does not prove which contract originated it. `DaoShipsError.code`
is stable for programmatic handling, and `stringify` emits bigints as exact JSON strings.

## Development and release

`npm test` builds, checks consumer types (including expected type errors), and runs offline
behavior tests in one process so restricted subprocess execution cannot hide assertions.
`npm run test:coverage` enforces aggregate minimums of 95% lines, 85% branches and 95%
functions over runtime modules, excluding generated ABI and creation-bytecode data.
Coverage flags require a recent Node 22 or Node 24+; ordinary tests support Node 22.0.0.
`npm run validate` combines coverage and package validation. Optional source-parity tests
skip explicitly when sibling sources are absent; `validate:workspace` requires those sources.
`npm run test:contracts` has also passed against source-verified local Solidity artifacts for
all three launch paths, governance execution/failure/defeat, Shares/Loot permit signatures,
native/ERC20 ragequit payouts, and deployments and representative lifecycles for all eight
navigators, including restricted/permit onboarding and recurring-payment recovery paths.
The first two suites use vault test doubles. A third suite uses the adjacent QuaiVault
contracts checkout's source-current implementation/proxy/factory artifacts to exercise
DAO launch and navigator activation through actual local owner proposal, approval and
execution. Set `DAOSHIPS_TEST_VAULT_CONTRACTS` if that checkout is elsewhere. These are
in-process Hardhat tests; public Quai RPC and shard-specific signing still need acceptance.
`npm run check:source` verifies all ABI hashes, generated method/event maps and navigator
compiler artifact provenance. `npm run sync:source` updates those checked-in artifacts when
upstream sources change; review the diff and rerun validation before shipping.

The SDK does not require sibling repositories at runtime or for ordinary builds/tests.
No CLI work is part of this SDK maturation. See [DESIGN.md](DESIGN.md) for architecture and
remaining release gates, including licensing, live acceptance and deployment identity.

Release tooling and integration additions: [npm publishing](docs/NPM_RELEASE.md),
[adapter conformance](docs/ADAPTER_CONFORMANCE.md), [IPFS reads](docs/IPFS.md), and
[Orchard acceptance](docs/ORCHARD_ACCEPTANCE.md). Contract artifacts default to `ipfs.qu.ai`;
other IPFS content defaults to `ipfs.io`, with explicit overrides. Review the IPFS guide's
gateway retirement notice before relying on the content default. Source validation also
checks all eight app navigator bytecodes against the source-verified SDK artifacts.
