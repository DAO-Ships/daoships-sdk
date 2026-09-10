# Final app-to-SDK proposal review

The app's `src/services/utils/ProposalDecoder.ts` supports proposal action inspection and commitment checks. The SDK previously exposed proposal encoding and hashing only, requiring every agent or voter integration to reimplement the packed MultiSend parser.

Added public exports through the existing SDK barrel:

- `decodeProposal(data, options?)`: returns ordered raw `{ operation: 0, to, value, data }` CALL entries with exact bigint native values. Empty protocol `0x` and a canonical empty MultiSend return an empty list. Unsupported operations, incomplete headers, impossible uint256 lengths, truncated action bodies, trailing data and noncanonical outer ABI encodings are rejected with `INVALID_ARGUMENT`. A malformed final action never produces a partial successful result.
- `verifyProposalDataHash(data, expectedHash, options?)`: compares the complete bytes against DAOShip's `keccak256(abi.encode(bytes))` commitment. Returns `false` for a valid mismatch and throws for malformed/missing input. The expected hash must come from a trusted chain read; comparing two indexer-supplied values does not authenticate either.
- `encodeProposal(actions, options?)`: retains its existing call signature and behavior for ordinary inputs, and now requires a nonempty dense array of own data properties. It rejects accessors, inherited action fields and oversized inputs with structured SDK errors.

Encoding/decoding defaults are 1,000 actions and 1 MiB of total encoded proposal bytes, configurable with `maxActions`/`maxBytes`. The byte bound includes selector, offsets, dynamic length and padding. Commitment verification uses the same default byte bound.

Decoding is structural inspection, not authorization or semantic verification. Governance-looking calldata directed at another address or carrying native value remains raw target/value/data. The SDK does not assign reassuring labels to unauthenticated targets. Applications can decode individual calldata with their selected `ContractClient.interface`, retain the outer target/native value, and separately verify DAO identity, permissions and intended effects. On-chain proposal simulation and receipt outcome validation remain necessary.

## Verification

`test/final-proposal-review.test.mjs` adds seven tests, including 20 deterministic round-trip vectors, malformed and overflowing lengths, unsupported operation bytes, exact byte/action boundaries, noncanonical outer calldata, sparse/inherited/accessor input, commitment matching, and governance-wrapper spoof preservation. The focused proposal/governance/SDK set passed 40 tests. TypeScript build passed. The local EVM suite also compares the decoded batch to its executed governance action and verifies its commitment against the DAOShip `hashOperation` result.

## Remaining app conveniences reviewed

These are integration conveniences or external services, distinct from missing underlying DAOShips contract methods:

| App source | SDK coverage and boundary |
| --- | --- |
| `services/core/TokenService.ts`, `services/dao/DaoWriteService.ts` | ERC20 balances/metadata/allowances, delegation/current/historical votes, proposals, ragequit and Poster calls are available through domain helpers or typed generic clients. SDK submission uses an actual shard block timestamp and capped threshold rather than the app's local-clock approximation. |
| `services/core/navigators/ERC20TributeNavService.ts` | SDK exposes tribute quoting, both onboard overloads/permit paths and ERC20 approvals. External-token EIP-5267/version/domain probing and zero-reset approval sequencing remain caller orchestration. `buildPermitTypedData` is specifically clone-safe version-1 DAOShips permit data, not universal permit discovery. |
| `utils/navigatorSanction.ts` | SDK exposes DAO permission mutations, vault module calls and sanctioned Poster records. Automatically planning the distinct permissioned navigator, Budget vault-module and Signal endorsement activation paths remains an integration convenience. A displayed/indexed navigator does not itself prove activation. |
| `services/utils/LaunchGasEstimator.ts`, `services/core/NavigatorDeployService.ts` | SDK exposes launch calls, creation bytes, prediction/mining, simulation and gas estimation during sending. App-specific modeled costs, multi-step affordability, deployment persistence and wallet creation sequencing remain caller-owned. Native contract creation is outside `sendPreparedTransaction`, which expects a destination. |
| `services/utils/ContractMetadataService.ts` | SDK bundles protocol ABIs and minimal-proxy inspection. IPFS/explorer ABI discovery for arbitrary external contracts, caching and media hosting are external integration services. |
| React query/realtime hooks and transaction UI | Cache invalidation, UI labels/deep links, browser wallet lifecycle and live subscriptions remain application behavior. The SDK supplies read/pagination/catch-up primitives and caller-provided signing/persistence boundaries. |

No CLI work or sibling application edits were made.
