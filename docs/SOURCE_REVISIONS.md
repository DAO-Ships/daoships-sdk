# Initial alpha source acceptance

The initial SDK source was checked on GitHub at commit
`540cc494a4ac4c54cadfafc0745c46e88f649286`:

- [Node 22/24/26 CI](https://github.com/DAO-Ships/daoships-sdk/actions/runs/34539634406) passed.
- [Source and contract acceptance](https://github.com/DAO-Ships/daoships-sdk/actions/runs/34539786181) passed.

Source acceptance compiled and tested these immutable revisions:

| Project | Revision |
| --- | --- |
| DAOShips contracts | `7a32ded20ca7eb4a1d07d04a90a96aaeafa48894` |
| DAOShips app | `e4922bdcdd186f7aea29987b31912e939c16d362` |
| DAOShips indexer | `e858a017c8e0f951a35a3cff198ab617f7cd2281` |
| QuaiVault contracts | `48f9ef2ccc7a24243df66ac02cb9249672abf751` |

The app and indexer revisions are available on their respective
`release/sdk-source-parity-20260910` branches. They contain only the reviewed artifact
synchronization and indexer ordering/profile-authority work. Those branches have not
been merged or deployed. The original local app/indexer main working trees were preserved.

Re-run source acceptance for the final SDK release commit, using the same four revisions
unless the intended contract/data release changes. This evidence establishes repository
source compatibility and local Solidity behavior; it does not establish funded Orchard
acceptance, indexer migration rollout or publication to npm.
