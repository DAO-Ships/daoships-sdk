# Launch, deployment, and governance SDK coverage

The source of protocol behavior is `daoships-contracts/contracts/core/{DAOShip,DAOShipLauncher,DAOShipAndVaultLauncher}.sol` and `contracts/libraries/Permissions.sol`. Bundled contract ABI snapshots independently verify function selectors and full launch argument decoding; optional source-parity checks run when sibling Solidity sources are available. The app's encoders, CREATE2 miner, and deployment verification tests were reviewed as integration references.

Implemented:

- Strict seven-field governance codec, protocol time/basis-point bounds, integer checks, uint256 preservation.
- Typed calldata and proposal-action builders for all governance-reachable DAO operations: four mint/burn batches, shares-to-loot conversion, pause configuration, governance configuration, navigator permissions, guild token enable/disable, and three permanent role locks.
- Permission routing reflects Solidity: navigator and guild-token updates always require proposal execution, including for role holders. Locks prevent future role grants; they do not revoke existing role permissions.
- Thirteen-field launch initialization encoding and decoding, member/navigator parallel-array validation, navigator limits/permission bits, distinct guild-token limits, separate Shares uint216 and Loot uint255 supply-cap checks, and strict pause flags.
- Direct DAOShipLauncher launch, combined launcher with existing vault, and atomic combined launcher with new vault; direct launch encodes the real avatar while combined-launch templates contain the replaced placeholder.
- ERC-1167 creation-code/hash generation; sender-specific packed salt derivation; deterministic CREATE2 predictions; vault constructor/init hash incorporating the DAO module, MultiSend target and zero delay; bounded cooperative salt mining with AbortSignal; two-phase clone/vault salt orchestration.
- Deployment graph discovery/verification from a supplied combined launcher. Reads chain ID, a mined Cyprus-1 block, all seven contract references and all eight bytecodes, then rechecks the block hash. Exact ERC-1167 runtime identification supports matching indexed DAOs to a known singleton.

Protocol differences from the app deliberately corrected:

1. Initial guild tokens do not need sorting. DAOShip.setUp deduplicates them and permits native QUAI (`address(0)`). Only ragequit withdrawal lists must be strictly sorted.
2. `setNavigators` and `setGuildTokens` use `governanceOnly`, not the GOVERNOR/ADMIN permission modifiers.
3. Salt ownership depends on the entry point. The direct launcher's salt sender is its caller; both combined-launch paths use the combined launcher as sender. `calculateAllAddresses` misleadingly accepts an arbitrary sender for clone prediction; passing the user EOA there does not match a real combined launch.

Limits integrators must handle:

- Encoding validates local inputs; it does not establish current balances, role locks, approvals, available gas, unused salts, bytecode identity, or vault module/delegatecall configuration. Simulate the exact transaction through the SDK contract/provider layer before signing.
- Existing-vault launches require vault owners to enable the DAO module and allowlist the configured MultiSend target before proposal execution works.
- Salt searches default to a deterministic start of zero; integrators must select fresh ranges and verify predicted addresses are unused. A search miss is a structured INVALID_ARGUMENT with the next salt so callers can resume. Cancellation is checked at each attempt and yields to the event loop every configured batch.
- Vault proxy creation bytecode is supplied explicitly; it must match the actual vault factory artifact. The SDK does not assume external vault infrastructure stays fixed.
- Deployment consistency does not prove a launcher is the current production deployment, that bytecode is audited, or that the indexer follows it. Supply the launcher from trusted deployment configuration and compare indexed DAO implementations as appropriate. There are no embedded current-address claims and no public-network validation. The optional `scripts/local-contract-smoke.cjs` passed against source-verified artifacts in a local Hardhat EVM, using explicit vault test doubles.
- Launch setup intentionally follows the contract's zero-address-member skip and duplicate-member mint behavior. It does not impose a voting-member bootstrap policy beyond contract constraints.
- No CLI work, signer custody, navigator deployment orchestration, or external vault transaction lifecycle is added by these modules.
