# npm release preparation

The initial target is `@daoships/sdk@0.1.0-alpha.0`, on npm's `alpha` tag. The public
GitHub repository is `DAO-Ships/daoships-sdk`; it has been created and this SDK is now
a local Git checkout. GitHub organization admin access and ownership of the npm scope
were verified through the restored CLI sessions. Publication remains disabled by
`private: true` pending the package's license selection. No package has been published yet.

## Repository setup

1. Create the SDK repository, commit the SDK and preserve `package-lock.json`.
2. Set `repository: { "type": "git", "url": "git+https://github.com/OWNER/REPO.git" }`,
   the chosen SPDX `license`, and the corresponding `LICENSE` text. Remove `private: true`
   when this package is ready for public publication.
3. Configure branch protection and the `npm` GitHub environment for the intended release
   maintainers. On npm, configure a trusted publisher matching the repository,
   `release.yml` workflow filename and `npm` environment. Establish scope/package ownership;
   an initial publication may require the maintainer's npm account bootstrap.
4. Require the SDK CI checks and run source acceptance against reviewed full sibling
   commit SHAs. Source acceptance must succeed on the **same SDK commit** as the release.

The release uses GitHub-hosted runners, Node 24, pinned npm 11.19.0, short-lived OIDC
credentials and npm provenance. It does not require a stored npm publishing token.
See npm's [trusted publishing requirements](https://docs.npmjs.com/trusted-publishers/)
and GitHub's [Node package publishing guide](https://docs.github.com/en/actions/tutorials/publish-packages/publish-nodejs-packages).
Public provenance requires the repository/package visibility and repository metadata
specified by those services.

## Prepared workflows

| Workflow | Checks |
| --- | --- |
| `ci.yml` | Node 22/24/26 behavioral coverage, consumer types, isolated package consumption and durable adapter crash tests. Node 24 also installs the packed consumer from the registry and checks high/critical dependency advisories. |
| `workspace.yml` | Manually selected immutable contract/app/indexer/vault revisions; clean dependency installs, contract compilation, ABI/type/schema/bytecode parity, local Solidity workflows and all SDK checks. |
| `release.yml` | A job without publishing permission checks version/tag/license/repository metadata and successful source acceptance for the exact SDK commit, then runs behavioral/package/adapter checks. A separate protected job verifies the retained archive's SHA-256 and source acceptance before publishing those exact bytes with npm provenance. |

Actions are pinned to reviewed commit SHAs. Dependency lifecycle scripts are disabled
for CI installs. Contract compilation is local; the workflows do not deploy contracts,
apply database migrations or run funded Orchard scenarios. GitHub workflow execution
and npm trusted-publisher setup still require the hosted repository; local checks alone
do not prove those permissions are configured correctly.

Only the protected `publish` job receives `id-token: write`. It installs the pinned
npm CLI with lifecycle scripts disabled, downloads this run's artifact by its immutable
artifact ID, and uses Node builtins to verify its SHA-256 against the validation job's
output. It does not install SDK dependencies, build the SDK or execute its tests.
The validation job's `test-package.mjs --save-release` retains its archive only after
the isolated runtime/type consumer passes. The publisher does not rebuild or repack it.
This separates dependency execution from npm publishing credentials; it does not replace
review of dependency changes or the contents produced by the validation job.

## Release procedure

Update the version and lockfile together, review changes and validation evidence, run
`npm run check:release`, and complete source acceptance for that commit. Create the exact
`v<package-version>` tag and publish the GitHub release (or manually dispatch the release
workflow on that tag). The release job checks the tag again and publishes a freshly packed
and tested archive. Prereleases use their named channel (`0.1.0-alpha.0` uses `alpha`);
channels that resemble npm semver ranges are rejected, and `latest` is reserved for stable
versions. Keep the lockfile, tag and recorded source revisions with the release evidence.
The workflow configuration and artifact checks have local coverage; hosted execution,
environment protection and trusted publishing remain to be verified after repository setup.

`npm pack` remains usable locally while the package is private. `prepublishOnly` blocks
ordinary local publication when required release metadata is absent. It is a guard,
not a substitute for repository/npm access controls or review of package contents.

## Initial CLI bootstrap and automation state

The initial publication is authorized through the maintainer's authenticated npm CLI.
After selecting the license and finalizing metadata, run the complete validation gates,
then `node scripts/test-package.mjs --save-release` to retain the exact validated archive.
Publish that archive with `npm publish .release/daoships-sdk.tgz --ignore-scripts --access public --tag alpha`.
An interactive npm 2FA challenge must be completed through npm's own authentication flow.
This local bootstrap does not claim GitHub OIDC provenance. Verify the registry's published
version, dist-tag, integrity and a fresh consumer installation afterward.

Future OIDC publication is currently disabled. Its job requires the explicit repository
variable `NPM_TRUSTED_PUBLISHING_ENABLED=true` as well as an approved publishing environment
and matching npm trusted publisher. Automatic approval review rejected configuring future
automated publishing under the initial-release authorization; no environment or trust
relationship was installed. Configure and enable it only after that separate authorization.
