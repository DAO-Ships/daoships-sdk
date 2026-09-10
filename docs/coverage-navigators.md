# Navigator, metadata and allowlist coverage

The SDK supports all eight navigator contracts present in `daoships-contracts/contracts/navigators/`. It uses canonical ABI fragments with typed argument tuples (every Solidity integer is `bigint`), typed read results, explicit overload signatures, named constructor configurations and local contract configuration validation. `Navigator` is framework independent and accepts the `call` method of a caller-owned quais provider. It never owns keys or broadcasts transactions.

| Contract | Writes covered | Reads covered |
| --- | --- | --- |
| Onboarder | Both `onboard` overloads, pause/unpause, native recovery | All pricing, caps, allowlist, expiry and mint accounting getters |
| ERC20Tribute | Both `onboard` overloads, permit onboarding, pause/unpause, token recovery | Tribute token/prices and all inherited accounting/configuration |
| NFTGated | Both onboarding overloads, pause/unpause | Holder/token eligibility, both `canOnboard` overloads, claimed token IDs and inherited accounting |
| Signal | Create, vote, cancel poll | Polls, results, option votes, voting participation/status, creation limits |
| Timelock | Queue, execute, cancel, emergency cancel, pause/unpause | Queue entries, executable status, timing constants/configuration |
| Vesting | Create schedule, claim, revoke, pause/unpause | Schedules, beneficiary IDs, vested/claimable amounts |
| Budget | Create/cancel budget, update manager, single/batch disbursement, pause/unpause | Budgets, remaining period/total capacity |
| Subscription | Pay/pay for member, collect, enroll/batch enroll, pause/unpause, token recovery | Quotes, enrollment/current/grace/delinquency/deadline, accepted tokens, fees/configuration |

All public constant, immutable and storage getters are included. The SDK uses zero-based navigator IDs as the contracts do; the separate DAO proposal ID validator is not applied to navigator IDs. Multi-output reads return tuples in ABI order, with labeled TypeScript tuple positions. Unique functions accept their bare names; overloaded functions require the complete signature.

```ts
import { Navigator, encodeNavigatorDeployment } from '@daoships/sdk';
import { NAVIGATOR_BYTECODES } from '@daoships/sdk/bytecode';

const polls = new Navigator('SignalNavigator', navigatorAddress, provider);
const results = await polls.read('getResults', [0n], { blockTag: blockNumber });
const action = polls.encode('vote', [0n, 1n]);
// Chain/provider verification and a pinned-block sender-aware simulation:
const prepared = await chain.prepareCall(action, walletAddress);
// The application passes prepared to its wallet/signing flow.

const creationData = encodeNavigatorDeployment('SignalNavigator',
  NAVIGATOR_BYTECODES.SignalNavigator, {
    daoShip: daoAddress, minSharesToCreatePoll: 1n,
    minDuration: 3600n, maxDuration: 86400n, maxStartDelay: 86400n,
    name: 'Community polls', description: '',
  });
```

Alternatively pass `navigatorDeploymentArgs(kind, config)` and the canonical ABI/bytecode to `quais.ContractFactory`. Native creation on Quai may require address grinding and ledger/shard-specific wallet handling; the SDK provides creation bytes and leaves that provider/wallet flow to the integrator. `parseNavigatorDeploymentReceipt` checks the expected emitting address, successful receipt, single constructor event, and optional DAO/deployer/type expectations. An emitted event by itself is not a bytecode identity attestation.

`quoteOnboarder` implements fixed-price whole-unit rounding/refunds and basis-point multiplier minting; `quoteERC20Tribute` implements separate floor-rounded raw share/loot prices and rejects dust, disabled sides and uint256 overflow. Quotes do not replace on-chain allowance, balance, cap, expiry and permission checks. Use simulation immediately before signing. NFT gate deployment must also find deployed code at the gate address; local configuration validation cannot establish this. `Navigator.read` and `simulate` do not independently verify network identity; use a configured `DaoShipsChain` for chain-checked preparation.

## Metadata

`buildPosterContent`, `validatePosterContent` and `encodePosterPost` cover all eight indexer tags: initial DAO profile, governance profile update, announcement, member profile, vote reason, navigator allowlist, complete navigator sanction set and signal poll labels. Content includes a schema version, strips indexer-disallowed control characters, and is bounded to 16 KiB of UTF-8 bytes. Unsupported fields, truncated strings, unsafe theme tokens and malformed inline allowlists fail locally. Poll IDs support exact bigint/decimal strings; optional `signalOptionCount` checks the on-chain label count.

Authentication is still enforced by the indexer: governance metadata/sanctions must originate from the avatar, initial profiles from the authorized deployer, allowlists from the indexed navigator deployer, and signal labels from the indexed poll creator while Pending/Active. The sanctioned navigator array is a complete replacement; `[]` clears the set. Vote direction in Poster is informational; the actual voting event remains canonical. The Poster contract is event-only and exposes no metadata read getter; use the indexer for materialized metadata.

DAO name, description and avatar columns support partial updates: omission keeps the column
and explicit null clears it through the indexer's raw-payload metadata extraction. Banner,
theme, links, tags and chain ID live in the latest profile record instead. Use
`buildDaoProfileUpdate` to carry unchanged record metadata forward and remove a record-only
field by omitting it from the resulting complete record. Raw Poster payload builders reject
null for those record-only fields. Initial profiles still require their required strings.
Member profiles require `daoAddress` in the SDK because the current
indexer routing path drops global posts, even though its isolated validator labels that field
optional. Indexer field limits are sometimes wider than the app form (profile name 100,
description 1000); SDK validation follows materialized behavior. HTTP, HTTPS and IPFS URLs
are supported by the indexer.

## Allowlists

`buildAllowlistTree` returns a serializable OpenZeppelin `standard-v1` dump or `null` for an empty list. It validates nonzero Cyprus-1 Quai addresses and deduplicates members. `getAllowlistProof` verifies all parent hashes and leaf/value indexes before providing a proof. `verifyAllowlistProof` implements Solidity's double-hashed address leaves and sorted node hashing; fixed fixtures produced by OpenZeppelin cover one/two/three/five-member trees. `verifyAllowlistRoot` catches corruption and mismatched roots. Only a canonical zero bytes32 root indicates open access.

Inline Poster allowlists validate the complete address set against the tree and root. Larger lists can post a validated IPFS CID with the committed root; fetching/pinning IPFS content remains an application responsibility, and downloaded trees should be checked with `verifyAllowlistRoot` before use.

## Artifact provenance and repository differences

`src/navigator-bytecodes.ts` is a separate optional module generated from the contracts project's existing artifacts, using Solidity `0.8.22+commit.4fc1097e`. Every source in each artifact's metadata dependency closure was compared byte-for-byte against its current repository or node_modules compiler input before bundling; each ABI was also compared with the app ABI. No browser service or singleton is imported.

The app's Onboarder, ERC20Tribute, NFTGated and Signal bytecode files differ from the current source-verified contracts artifacts. The bundled SDK bytecode uses the contracts artifacts. Timelock, Vesting, Budget and Subscription app bytecodes match. This is a repository integration issue to resolve before claiming deployment parity with the UI; deployment addresses are not inferred from these artifacts.

Subscription frontend validation also diverges from Solidity: the contract permits periods from one hour to 3650 days and caps collector rewards at 1000 basis points (10%). The current form validator uses one day to roughly three years and a 10000-basis-point cap. SDK validation follows Solidity. Contracts, indexer and app were inspected locally; these capabilities have offline regression coverage but were not broadcast on a live network.
