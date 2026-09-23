# Source revisions

## 0.1.0-alpha.4

Source acceptance for this release uses the deployed app and indexer, which now carry the
reviewed artifact synchronization and ordering/profile-authority work on `main`:

| Project | Revision |
| --- | --- |
| DAOShips contracts | `7a32ded20ca7eb4a1d07d04a90a96aaeafa48894` |
| DAOShips app | `4e4ded767e09119e85cfe33dca69c6a93ea12dcc` |
| DAOShips indexer | `d8778baadcc31ac4eb399302869f25611091d15d` |
| QuaiVault contracts | `48f9ef2ccc7a24243df66ac02cb9249672abf751` |

Contracts and QuaiVault are unchanged from the initial alpha. The indexer revision is the one
running on both hosted services, with its record-ordering migration and backfill applied
(2026-09-22/23), which the release's ordered-read default relies on. Run links for this
release's CI and source acceptance are recorded on its GitHub release.

## Initial alpha source acceptance

The initial SDK source was checked on GitHub at commit
`0a85f593539d2713e9fbdb3fbb9c18970da592d7`:

- [Node 22/24/26 CI](https://github.com/DAO-Ships/daoships-sdk/actions/runs/34606343038) passed.
- [Source and contract acceptance](https://github.com/DAO-Ships/daoships-sdk/actions/runs/34606340961) passed.

Source acceptance compiled and tested these immutable revisions:

| Project | Revision |
| --- | --- |
| DAOShips contracts | `7a32ded20ca7eb4a1d07d04a90a96aaeafa48894` |
| DAOShips app | `e4922bdcdd186f7aea29987b31912e939c16d362` |
| DAOShips indexer | `e858a017c8e0f951a35a3cff198ab617f7cd2281` |
| QuaiVault contracts | `48f9ef2ccc7a24243df66ac02cb9249672abf751` |

The app and indexer revisions were the tips of their `release/sdk-source-parity-20260910`
branches, containing only the reviewed artifact synchronization and indexer
ordering/profile-authority work. That work has since landed on each `main` (app `1b70a71`,
patch-identical; indexer `31fdfde`/`0e31471`, later extended) and been deployed, and the
branches were deleted on 2026-09-23.

Re-run source acceptance for every subsequent SDK release commit, using the same four revisions
unless the intended contract/data release changes. This evidence establishes repository
source compatibility and local Solidity behavior; it does not establish funded Orchard
acceptance, indexer migration rollout or publication to npm.
