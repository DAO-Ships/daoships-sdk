# Repository integration findings

These findings came from comparing the SDK against local contracts, app and indexer sources.
Other projects were reviewed but not changed. They should be resolved or understood before
claiming identical behavior across all integrations.

| Finding | Evidence | SDK behavior |
| --- | --- | --- |
| Four app navigator creation bytecodes differ from current compiled contracts | `daoships-app/src/config/abi/{Onboarder,ERC20Tribute,NFTGated,Signal}Navigator.bytecode.ts` versus `daoships-contracts/artifacts/contracts/navigators/*` | Bundles the contract artifacts only after checking metadata's exact source dependency closure, compiler output, and ABI parity. Timelock/Vesting/Budget/Subscription match the app. |
| Subscription form bounds differ from Solidity | Subscription contract accepts 1 hour–3650 days, collector reward at most 1000 bps; app uses narrower period bounds and a wider reward bound | Constructor validation follows Solidity. |
| Profile clearing depends on materialization, not just the schema validator | `extractDaoMetadataUpdates` checks raw explicit nulls for name, description and avatar after validation | Raw DAO profile builders preserve null for those three materialized columns; omission preserves them. Other profile fields live in the latest record and require carry-forward. |
| Global member profile routing is incomplete upstream | Member-profile schema calls daoAddress optional, but the ordinary NewPost routing path skips records without a resolved DAO | SDK requires daoAddress for member profile posts so accepted payloads can materialize. |
| Profiles combine column merging and record replacement | Developer agent notes describe profile replacement; the handler merges three columns while the app reads banner/theme/links/tags from the latest profile record | `buildDaoProfileUpdate` preserves unchanged record-only metadata and distinguishes clears from omission. Navigator sanction arrays remain complete replacement sets. |
| Direct roles do not authorize all governance actions | `setNavigators`, `setGuildTokens`, and role-lock functions use `governanceOnly` in DAOShip | Governance actions wrap `executeAsGovernance`; permission routing respects the modifier. |
| Launch and ragequit treat token lists differently | Launch deduplicates guild tokens; ragequit requires strictly ascending unique addresses | Launch preserves Solidity initialization behavior; ragequit preparation sorts explicitly supplied tokens and rejects duplicates. |
| Mint caps differ by token | Shares cap is `uint216.max`; loot cap is `uint256.max / 2` | Launch and mint builders enforce the relevant known bounds; current-state simulation remains necessary. |
| NUMERIC arrays can lose precision with ordinary JSON reads | Signal poll `tally` is `NUMERIC(78,0)[]` | Full table projection casts the array to text before parsing and validates every integer element. |
| Transaction success does not equal proposal action success | `processProposal` can emit passed=false or actionFailed=true with receipt status 1 | Event parsers verify emitter/ID and expose execution, defeat and action failure separately. |

`npm run check:source` reproduces artifact parity checks against the available repositories.
Runtime tests and release validation must still account for which contract versions are
actually deployed on each network.
