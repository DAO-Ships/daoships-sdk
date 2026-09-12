# DAO and navigator function coverage

Reverified 2026-09-12 against current Solidity artifacts with SDK `0.1.0-alpha.3`.
All **228 functions** on DAOShip
and the eight navigators are available through typed SDK clients, including inherited
methods and overloads. The local Solidity suites successfully execute every write and
read every getter through the SDK. This is function coverage, not exhaustive branch,
adversarial or live-network coverage.

| Contract | Typed functions | Local SDK reads | Local SDK writes | Recorded Orchard evidence |
| --- | ---: | ---: | ---: | --- |
| DAOShip | 62 | 41/41 | 21/21 | Three launches; proposal submission/voting/processing, defeated closure, configuration and navigator grants |
| OnboarderNavigator | 21 | 16/16 | 5/5 | Deployment, activation and native onboarding |
| ERC20TributeNavigator | 19 | 13/13 | 6/6 | Deployment, activation and ERC20 tribute |
| NFTGatedNavigator | 24 | 20/20 | 4/4 | Deployment, activation and membership claim |
| SignalNavigator | 19 | 16/16 | 3/3 | Deployment, governance endorsement and weighted voting |
| TimelockNavigator | 20 | 14/14 | 6/6 | Deployment, activation and execution after the real delay |
| VestingNavigator | 14 | 9/9 | 5/5 | Deployment, activation and claims |
| BudgetNavigator | 17 | 10/10 | 7/7 | Deployment, vault module activation, funding, spending and cancellation |
| SubscriptionNavigator | 32 | 24/24 | 8/8 | Deployment, activation and fee payment |
| Total | **228** | **163/163** | **65/65** | Core business workflows recorded; not every write or branch exercised live |

## Executable checks

The 2026-09-12 review passed `npm run validate:workspace`: 339 SDK tests, coverage
gates, declaration consumers, package checks, source/ABI parity, all local Solidity
suites and 13 adapter conformance tests. The full package exposes 353 functions and
103 events across 17 interfaces. Read-only chain identity and explicit Cyprus-1 block
reads passed on both Orchard and mainnet; this review sent no new live transactions.

All four local Solidity suites and source/ABI/type parity passed again during the
[2026-09-11 SDK review](SDK_AUDIT_2026-09-11.md), which records current behavioral
test counts, runtime coverage and package checks. Provider regressions include a
captured Orchard block with smoke nonce 6715 and mainnet nonce 25. These checks add
no live transaction evidence.

Run `npm run test:contracts` with the sibling dependencies and source-current compiler
artifacts available. It runs four isolated Hardhat suites without `.env` or public RPC.
DAO/navigator behavior suites use real DAO/token/navigator bytecode and MockAvatar;
the separate deployment suite uses actual QuaiVault artifacts for launch/activation.

`scripts/local-function-coverage.cjs` enumerates the ABI at runtime. Writes count only
after successful execution. Nested governance actions count only when ProcessProposal
confirms action success; avatar-mediated navigator calls must emit a decoded navigator
event. Reverts and failed actions cannot fill gaps. Each getter has an explicit fixture
and is compared with an independent ethers read at the same block. New functions fail
the suite until execution/read fixtures are added. `npm run check:source` separately
checks that the ABI and generated method maps include every current compiled function.

`scripts/local-dao-functions.cjs` covers initializer/replay, privileged access, mint/burn/
conversion supply accounting, token pause controls, guild token removal/restoration,
exact offerings, third-party sponsorship, batch votes and atomic duplicate rejection,
cancellation, successful/defeated outcomes, ragequit, all three assignment locks,
retained operator/governance powers and revocation. The existing core suite retains
permit, ERC20 ragequit and failed MultiSend rollback coverage.

`scripts/local-navigators-smoke.cjs` covers pricing/refunds, Merkle onboarding overloads,
ERC20 allowance and real permit/replay, NFT ownership and transfer-after-claim rejection,
weighted polls and cancellation permissions, timelock maturity/hash/replay/cancellation/
emergency/expiry, vesting cliff/claim/revocation, native/ERC20 budget ceilings/rollover/
rotation/batch rollback, subscription payments/gifts/collection/conversion/reward/
re-enrollment/grace boundaries, pause controls and stuck-asset recovery.

## SDK finding corrected

Pinned `quais@1.0.0-alpha.53` parses hexadecimal transaction nonces as decimal, breaking
confirmation/recovery comparisons. The workaround previously lived only in the Orchard
harness. `DaoShipsProvider` is now exported from `@daoships/sdk`; the harness imports
that same implementation. `OrchardProvider` remains an alias. Exact normalization
covers individual transactions and full blocks; malformed/unsafe quantities are rejected. Existing default-read-sender fixes
are included in `0.1.0-alpha.2`.

```ts
import { DaoShipsProvider } from '@daoships/sdk';

const provider = new DaoShipsProvider(
  'https://orchard.rpc.quai.network/cyprus1', 15000, { usePathing: false },
);
// Pass this provider to Navigator, ContractClient, DaoShipsChain and your signer.
```

`Navigator.encode/read/simulate` supports every navigator function. `ContractClient`
provides complete contract access. DAO preparation and governance-action helpers cover
the proposal lifecycle and privileged operations. Generic calls still require the
correct signer/governance route and expected event/state checks; ABI completeness does
not imply a specialized eligibility, quote or outcome helper for each business action.

Mainnet uses the same provider with chain ID 9 and its own RPC/deployment addresses.
Read-only mainnet retrieval on 2026-09-11 confirmed chain 9 and captured block 10,044,857;
the regression checks both transaction and prefetched-block nonce 25 (`0x19`). A live
`DaoShipsProvider` read independently passed chain identity, transaction lookup and
prefetched-block decoding at that height. All 21 targeted provider/Orchard tests,
consumer type checks and the packed package checks passed. This establishes read and
formatter compatibility, not funded mainnet lifecycle acceptance.

## Remaining gaps

1. **Remaining live execution:** The separate
   [CLI acceptance campaign](https://github.com/DAO-Ships/daoships-cli/blob/main/docs/orchard-testing.md)
   completed 23 confirmed transactions across 15 scenarios, with 16 exact contract
   rejection checks. It covers the core business workflows in the table above and
   reruns completed work without broadcasting again. It does not cover all 65 writes,
   every privileged mutation or permit variant, hour-long subscription delinquency,
   or budget period rollover. Preserve its separate fixtures and transaction evidence.
2. **Boundary and hostile-token coverage:** Further SDK-driven cases include
   fee-on-transfer tribute/subscriptions, permit frontrunning with allowance fallback,
   delegated-vote snapshot changes, repeated partial vesting claims before revocation,
   and broader expiry/cap/retention boundaries. Sibling Solidity tests provide additional
   evidence but do not substitute for testing the SDK paths.
3. **Workflow conveniences:** Per-action navigator preparation and outcome helpers
   would reduce application code. Today callers combine typed calls, simulation,
   generic chain preparation and event decoding. Add dedicated helpers around
   demonstrated integration needs, with state and caller checks.
4. **Live recovery faults:** Recorded evidence covers lost acknowledgements and
   restart reconciliation. Same-nonce replacements and real reorg behavior still need
   live evidence where the testnet permits deterministic reproduction.

See [Orchard acceptance](ORCHARD_ACCEPTANCE.md) for the recorded live scope and
[feature coverage](FEATURE_COVERAGE.md) for the rest of the SDK.
