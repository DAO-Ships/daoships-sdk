> Historical review: the 2026-09-10 release audit corrected the vault pagination model described below. Actual QuaiVault returns the first unreturned module as `next`; SDK traversal now resumes from the last returned module. See `release-protocol-audit.md`.

# Final protocol and application completeness review

The review went beyond ABI counts: it compared app workflows with SDK semantics and the outer indexer routing that actually accepts or rejects Poster posts. No CLI changes were made.

## Corrected integration gaps

- **DAO profile clearing:** `DaoProfileUpdateMetadata` now accepts explicit `null` for `name`, `description` and `avatar`. The serialized on-chain JSON preserves those nulls, which `daoships-indexer/src/handlers/poster.ts:519` uses to clear `ds_daos` columns. Omission preserves these three materialized columns. Initial profiles remain strict. Record-only profile fields (`banner`, `theme`, `links`, `tags`, `chainId`) have different semantics: consumers read them from the latest profile record, so a later partial post can drop them. This update does not imply merge behavior for all profile fields.
- **Member profile routing:** `PosterPayloads['daoships.member.profile']` now requires `daoAddress`. Although the indexer's standalone content validator allows absence, `handleNewPost` rejects normal-path posts without a known DAO at `daoships-indexer/src/handlers/poster.ts:677`. A global member-profile payload previously passed SDK validation but never reached the indexer's records.
- **Vault module revocation:** `resolveVaultModulePredecessor` supplies the pointer needed by `disableModule(prev,module)` through bounded pagination. The app's `daoships-app/src/utils/budgetProposals.ts:147` reads only the first 100 modules. The SDK walks the next-page cursor documented by `daoships-contracts/contracts/interfaces/IAvatar.sol:85`, carries the previous module across pages, requires a fixed block identifier, forwards read timeout/cancellation options and rejects corrupt or incomplete traversals. Reaching a request limit throws; it does not falsely report that a module is absent.
- **Navigator authorization requirements:** `getNavigatorRequirements` and `NAVIGATOR_REQUIREMENTS` distinguish DAO MANAGER/GOVERNOR grants from Budget's separate vault-module permission and Signal's indexed DAO endorsement. They follow `daoships-app/src/config/navigatorCatalog.ts` and `daoships-app/src/utils/navigatorSanction.ts`, checked against the concrete contracts' privileged calls. Signal endorsement is an indexing/trust requirement, not a prerequisite enforced by the voting contract.

Example module revocation preparation:

```ts
const previous = await resolveVaultModulePredecessor(provider, vaultAddress, navigatorAddress, {
  blockTag: checkedBlockNumber,
  from: ownerAddress,
  pageSize: 100,
  maxPages: 100,
  maxModules: 10_000,
  signal,
});
if (previous !== null) {
  const call = new ContractClient('QuaiVault', vaultAddress).encode('disableModule', [previous, navigatorAddress]);
  // Feed this call into the vault's authorized owner/governance workflow.
}
```

The lookup defaults to 100 modules per page, 100 pages and 10,000 total modules; page size cannot exceed 1,000. It accepts a fixed nonnegative numeric block or explicit hexadecimal block identifier, and rejects moving tags such as `latest`/`pending`. A block number does not itself establish finality. The caller must trust and verify its chosen provider, chain and vault; the helper is not a deployment attestation. Resolve the pointer again during refreshed preparation because another module change may invalidate it. Wallet owner-consensus collection and signing remain caller-owned.

`test/final-protocol-review.test.mjs` covers the two Poster routing/update corrections; head, middle and page-boundary predecessors; confirmed absence; duplicate/sentinel/zero nodes; cursor cycles; oversized pages; resource exhaustion; fixed-block requirements; cancellation/timeouts; caller option mutation during an outstanding page; and all eight authorization mappings. The targeted final suite passed 29 tests together with existing Poster and protocol audit tests.

## Other findings and scope decisions

- The app has a proposal-data decoder in `services/utils/ProposalDecoder.ts`; SDK encoding alone was insufficient for safely inspecting proposals authored elsewhere. This finding was handed to the transaction reviewer for a strict SDK decoder rather than copying the app's best-effort partial parser.
- App `utils/profileUpdate.ts` demonstrates the need to carry forward fields stored only in the latest profile record. This was handed to the profile-helper owner; nullable materialized fields alone do not solve that issue.
- The app calculates ragequit payout estimates and retention limits in `components/member/RagequitModal.tsx:205`. SDK chain reads, exact arithmetic primitives and ragequit preparation make this possible, but no dedicated payout-estimate helper was added in this review. Such an estimate should use one checked block, preserve Solidity rounding and flag intentionally omitted guild tokens.
- Navigator admin action deep links, interface labels, wallet connections, transaction storage, IPFS pinning and infrastructure provisioning remain application responsibilities. Existing `Navigator.encode`, `ContractClient.encode`, `encodeProposal` and chain preparation already provide their underlying protocol calls. Recreating UI-specific wrappers would not add a missing integration capability.

Method coverage and these targeted improvements still do not imply production QuaiVault consent acceptance, live Quai routing acceptance or exhaustive testing of every protocol state transition. See [the protocol audit](audit-protocol.md) for the executed local workflows and remaining acceptance gaps.
