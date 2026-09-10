# Repeatable package and feature verification

The development checkout includes two optional verification scripts. They are excluded from the published-package file allowlist; SDK runtime imports never load them.

```sh
npm run build
node scripts/test-package.mjs
node scripts/check-feature-coverage.mjs
```

## Packed consumer verification

`test-package.mjs` creates an actual `npm pack` tarball with lifecycle hooks disabled and npm in offline mode, using a fresh temporary cache. It extracts the tarball outside the workspace and links only the already-installed `quais` dependency, which resolves its existing transitive dependencies. This verifies package isolation and dependency declarations; it does **not** claim a fresh registry install or independently verify npm download availability.

The checks cover:

- Exactly five export subpaths (`.`, `abis`, `contracts`, `indexer`, `bytecode`), imported by a separate ESM consumer that encodes a token approval, parses an exact token amount and reads a fixture indexer response.
- Runtime Node filesystem permissions allowing only the extracted package/consumer and installed dependencies. Original SDK source/dist and sibling application, contracts and indexer files are inaccessible to the consumer.
- Strict TypeScript consumer compilation against packaged declarations, with library declaration checking enabled and negative assertions for unsafe numeric arguments, unknown contract methods and private indexer tables.
- Static import/export/dynamic-import graph checks for every emitted JavaScript module and declaration. Only package-local targets and the declared `quais` dependency are accepted.
- Every relative Markdown inline/reference link in packaged documents resolving to a packaged target. Local absolute links, package escapes and missing targets fail. HTTP links are not fetched, and Markdown heading fragments are not validated.
- Development sources, tests, scripts, CLI examples and `node_modules` excluded from the tarball. Temporary consumer/cache/archive files are removed in `finally`, including on failure.

The audit run passed with 52 emitted modules/declarations validated. The script reports the current documentation-link count dynamically. It requires the local `tar` utility and Node's permission model. Environments that prohibit subprocess creation must run it with their normal local-process permission; spawn failures are checked explicitly instead of being counted as success.

The 2026-09-10 release review adds two checks. `build` clears `dist` before compilation,
and the package checker rejects emitted files with no corresponding current source module
or with unexpected extensions. `npm run test:package:registry` opts into a fresh npm cache
and installs the actual tarball and its dependencies without lifecycle scripts. It runs the
same ESM/declaration consumer checks with runtime filesystem reads restricted to the
temporary installation. The ordinary `test:package` command remains offline. Current
validation results are in [release readiness](RELEASE_READINESS.md).

## Current-source feature coverage

`check-feature-coverage.mjs` independently compares bundled ABIs against the Solidity compiler output for all 14 concrete DAOShips contracts. Before comparison, it verifies every source dependency recorded in each contract's compiler metadata against current sibling source/dependency files. Stale artifacts fail the audit rather than silently validating an old build.

The compiler AST supplies each declared public/external function and its selector. The compiler's complete `methodIdentifiers` map additionally covers inherited methods, overloads and generated public getters. Every compiler ABI is compared directly with the SDK ABI, including its event/input/output definitions. The script also compares generated `ContractMethods` and `ContractEvents` keys with all 17 bundled ABI interfaces, checking full Solidity signatures and only unambiguous shorthand aliases.

The audit run verified **116 declared functions**, **291 compiled methods** across the 14 concrete contracts, and **353 ABI functions / 103 ABI events** across all 17 bundled interfaces. It performed 178 compiler source-dependency comparisons. External QuaiVault/QuaiVaultProxy snapshots receive generated-map coverage; this script does not establish their current deployed bytecode or ownership consensus behavior.

This proves method/event representation and artifact freshness. It does not establish that every method has a dedicated SDK convenience, complete preflight policy, receipt validator or live-chain acceptance test. See the [feature matrix](FEATURE_COVERAGE.md) for those distinctions and remaining integration requirements.
