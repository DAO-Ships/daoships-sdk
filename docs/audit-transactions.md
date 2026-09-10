# Transaction and chain audit — 2026-09-09

Scope: `chain.ts`, `transactions.ts`, `receipts.ts`, `tokens.ts`, and `values.ts`; cross-review of generic contract/event access. Contract comparison used the local DAOShip `submitProposal`, `processProposal`, and `ragequit` implementations and clone permit domain implementation. Provider behavior was checked against the installed quais source. This is an internal code audit with offline adversarial tests, not independent security certification.

## Findings fixed

| Severity | Finding and reproduction | Resolution |
| --- | --- | --- |
| High | `prepareCall` read its mutable input after fetching the block; `prepareVotes` reread mutable vote objects after preflight. A caller update while an RPC promise was pending could change the target, value, proposal IDs or vote direction. | Capture transaction fields and copy vote objects before the first await. Regression cases mutate inputs from the provider callback. |
| High | The request passed to `estimateGas` was reused for broadcasting. An adapter modifying that request could change its destination/value/data after refresh comparisons. | Give estimation a separate shallow copy; all fields are validated primitive values. Broadcast reconstructs the request from captured intent. |
| Medium | Wallet account/network were only checked before gas estimation. A network/account/provider switch while estimation was pending could reach broadcast. | Check provider identity, network and account before estimation and immediately before broadcast. Explicit chain ID and sender remain in the request. |
| Medium | Chain reads used one block number but returned the original block hash without checking for a reorg. Reads could combine values from different canonical blocks. | Verify the block hash, height and network after successful read batches and simulations. Reject changed or unverifiable snapshots. |
| Medium | A `null` or unknown receipt status was reported as `TX_REVERTED`. An integration might then retry a transaction whose outcome was still unknown. | Only numeric status `0` means reverted; only numeric `1` means successful. Other values produce `TX_PENDING`. Reject confirmation receipts whose supplied hash differs from the submitted hash. |
| Medium | Chain RPC promises could hang indefinitely and large call responses were decoded without a limit. | Added optional `ChainOptions` constructor argument with per-operation `timeoutMs` (30,000 default) and `maxResponseBytes` (1 MiB default). Validate response bytes before ABI decoding and check deferred decode errors. |
| Low | Changing send/confirmation options across awaits could replace the persistence callback, change gas padding or change the resume timeout. | Capture callback, gas multiplier, signal and timeout values before yielding. Cancellation during the scheduling gap avoids starting a provider wait. |
| Low | Invalid chain IDs, zero or overflowing padded gas estimates, and malformed broadcast hashes lacked explicit checks. | Reject invalid preparations/estimates before send; malformed broadcast responses retain uncertain outcome semantics and are never retried automatically. |
| Low | `hex` accepted coercible objects; arbitrary `uint` bit widths could allocate oversized integers or throw native exceptions. Token permit names accepted truthy nonstrings. | Require byte strings, bound widths to 1–256, validate permit name type, and reject oversized token integer magnitudes before BigInt conversion. |

## Validation

`test/audit-transactions.test.mjs` adds adversarial regression cases for the findings above, including reorgs, network switching, input/estimator mutation, callback replacement, malformed hashes and receipt statuses, cancellation races, and hung providers. The transaction/chain regression subset (new tests plus existing SDK, core-review and transaction tests) passed 56 tests with Node 26 using `--test-isolation=none`. TypeScript builds passed. Final whole-package totals and runtime compatibility checks belong to the aggregate SDK audit.

Contract checks confirmed that `processProposal` checks vault module enablement even for defeated closures; the SDK preserves that check. Its retention comparison uses the same integer floor and 10,000 divisor. Permit domain uses token clone name, version `1`, chain ID and clone address. Generic typed ABI access exposes token methods beyond the convenience wrappers.

## Remaining limits and release coverage

- These tests exercise controlled providers and signers. Hosted Quai RPC behavior, real wallet switches, hosted indexer acceptance, and production QuaiVault execution require integration acceptance against the intended deployment.
- The provider and signer are trusted execution dependencies. A signer can ignore the explicit transaction request or change internally after the final check; an SDK cannot atomically lock an external wallet. The final wallet must enforce chain ID, sender and approved calldata/value.
- Block-number verification detects observed reorgs during the read batch. It cannot prevent a later reorg, a reorg away and back between observations, or a dishonest/cached provider. Choose an appropriate confirmation depth and retain transaction hashes for recovery.
- A successful `processProposal` simulation or receipt status does not prove that its inner action succeeded. Parse the DAO's exact `ProcessProposal` event and call `assertActionSucceeded` for intended execution. Gas padding is a heuristic, not an execution guarantee.
- Broadcast errors, persistence errors and confirmation timeouts must not trigger blind resubmission. The SDK does not automatically reconcile replacement transactions, allocate nonces across concurrent processes, or promise exactly-once delivery; integrations must persist intent/hash and coordinate their signer.
- Chain timeouts bound the SDK wait per RPC operation. They cannot abort work inside an arbitrary caller-supplied provider. Multi-step methods may perform several sequential operations.
- Generic `DaoShipsToken.metadata()` uses the caller's read options. Callers requiring a consistent metadata snapshot should supply an explicit block tag; its default latest reads are independent.
- Ragequit intentionally preserves the caller's explicit token selection. Omitted guild tokens are forfeited for burned shares/loot, and an empty list withdraws nothing. Applications should present the complete selection and burn amounts for review.

## Added local contract execution coverage

The isolated `scripts/local-contract-smoke.cjs` now also executes these flows using SDK encoders and decoders against source-verified compiled DAOShip/token/launcher contracts:

- Both SharesERC20 and LootERC20 clone permits: SDK EIP-712 domain equals the contract domain separator, local signer produces a signature, and a relayer submits SDK permit calldata. Assert allowance and nonce updates, Approval decoding, wrong-chain/wrong-clone/replayed/expired signature rejection, unchanged nonce on rejection, allowance overdraw rejection, and successful SDK transferFrom spending.
- Mixed native/ERC20 ragequit: assert exact beneficiary and vault balance deltas against the common shares-plus-loot supply denominator, owner token burns, supply decrements, and all decoded Ragequit event fields. Rejected unsorted token selection leaves shares and loot intact.
- A passing proposal whose second action reverts: outer transaction status remains successful, SDK parsing returns `action_failed`, `assertActionSucceeded` rejects, and the first action's mint is rolled back atomically. Reprocessing is refused by the contract's `NotReady` state guard.
- A voted-down proposal closes as `defeated`, and `assertActionSucceeded` reports `PROPOSAL_DEFEATED`.

The script retains all three launch paths, CREATE2 prediction and successful governance mint execution. It passed against an isolated in-memory Hardhat network. The vault factory/avatar and treasury ERC20 remain explicit test doubles; the SDK's Cyprus-1 provider adapter and production QuaiVault implementation are not validated by this local EVM run. No public RPC, production transaction, contract recompilation or sibling source mutation was used.
