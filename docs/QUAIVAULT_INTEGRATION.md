# QuaiVault SDK integration decision

Reviewed 2026-09-09 against the installed sibling `quaivault-sdk` source and the published
[`@quaivault/sdk` package](https://www.npmjs.com/package/@quaivault/sdk).

Use the QuaiVault SDK at the application's vault boundary. Do not make it a mandatory
DAOShips runtime dependency at this time. DAOShips owns DAO launch semantics, proposals,
membership, navigator lifecycle and DAO-indexed data. QuaiVault already owns multisig
proposal creation, approvals, owner consensus, execution delays and vault transaction
outcomes; duplicating that orchestration here would add conflicting policy.

The reviewed QuaiVault SDK is 0.6.0. It declares `quais` peers
`1.0.0-alpha.55 || 1.0.0-alpha.56`, whereas this SDK pins `1.0.0-alpha.53`, matching the
DAOShips repositories. It also depends on PostgREST/Realtime clients and Zod. A required
dependency would force a wallet-library compatibility migration and introduce vault and
transport dependencies for users who only need DAO reads or unsigned proposal encoding.
No such migration or dependency installation is necessary for primitive call composition.

## Composition boundary

SDK workflow steps distinguish a plain transaction, contract creation, DAO governance and
vault consent. All navigator activation steps use DAO governance, including Budget's vault
module grant. Vault consent is reserved for existing-vault bootstrap in the deployment
plans. Supply an executor for the appropriate authority. A bootstrap vault step can hand its
validated `{ to, value, data }` to the application-owned QuaiVault client:

```ts
// qv is the application's configured @quaivault/sdk client.
// setupCall is an unsigned vault-setup call from a reviewed DAOShips workflow plan.
const vault = qv.vault(vaultAddress);
const review = await vault.propose.call({
  to: setupCall.to,
  value: setupCall.value,
  data: setupCall.data,
  dryRun: true,
});
```

Owner-authorized submission uses that SDK's proposal/approval/execution lifecycle. A vault
proposal is not an executed setup operation. Its `txHash` identifies the vault proposal;
`chainTxHash` identifies the Quai transaction carrying it. Store these separately. Require
the vault SDK's successful execution outcome and DAOShips' relevant chain postconditions
before completing the deployment step. A successful proposal transaction receipt alone
must not activate the next step.

The structural boundary uses addresses, bytes and bigint values. It does not exchange
provider, signer or contract instances across different quais installations. Applications
using both libraries should select a mutually tested quais version before sharing those
instances; this change does not claim alpha.53/55/56 interchangeability.

## When a dependency would add value

A separate optional adapter package becomes useful when multiple integrations need the
same persisted vault-consent orchestration and both SDKs share a tested wallet-library
matrix. That adapter can depend on `@quaivault/sdk` explicitly and translate its outcomes
without importing multisig policy into the DAOShips core. Until then, the small executor
boundary is sufficient and keeps existing-vault, externally managed vault and read-only
integrations usable.

Existing typed vault ABI access remains available for DAO-required setup, discovery and
module checks. It is not presented as a replacement for the QuaiVault SDK. The dependency
decision does not prevent using real QuaiVault contracts in isolated integration tests.
