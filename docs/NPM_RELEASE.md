# npm releases

`@daoships/sdk` is MIT licensed and published publicly from
[`DAO-Ships/daoships-sdk`](https://github.com/DAO-Ships/daoships-sdk).
The initial `0.1.0-alpha.0` upload used the authenticated npm CLI. It does not
have GitHub OIDC provenance; its tested archive is attached to the GitHub prerelease.

## Tag-triggered publication

Pushing `v<package-version>` starts `release.yml`. Publishing a GitHub release does
not start a second upload. Manual dispatch on the same tag supports retries after
transient failures. Runs for the same tag are serialized without cancelling an upload.

1. Update `package.json` and `package-lock.json` together, and commit the reviewed changes.
2. Run SDK CI and dispatch `workspace.yml` on that exact commit, supplying reviewed full
   contract, app, indexer and vault commit SHAs. See [source revisions](SOURCE_REVISIONS.md).
3. Wait for source acceptance to pass, then create and push an annotated tag matching
   the package version. No further source changes may be included in that tag.
4. Check the release workflow, npm version, dist-tag, integrity and consumer installation.
   Create the GitHub release for the same tag once publication succeeds.

Prereleases use their named channel: `0.1.0-alpha.1` publishes to `alpha`.
Stable versions use `latest`. The workflow rejects mismatched tags, invalid metadata
and missing source acceptance for the exact tagged commit. An already published version
cannot be overwritten: use a new version for changed package contents.

## Validation and publishing permissions

| Workflow | Checks |
| --- | --- |
| `ci.yml` | Node 22/24/26 coverage, consumer types, isolated package consumption and adapter crash tests; Node 24 also checks a fresh dependency install and high/critical advisories. |
| `workspace.yml` | Reviewed immutable sibling revisions, contract compilation, ABI/type/schema/bytecode parity, local Solidity workflows and SDK checks. |
| `release.yml` | Version/tag/license/repository metadata and successful source acceptance on the exact commit, behavioral coverage, adapter tests and an isolated package consumer before publication. |

The validation job has no publishing permission. It retains the exact archive that
passed the package consumer. The separate publisher downloads that run's artifact by
immutable artifact ID, verifies SHA-256, rechecks source acceptance and publishes those
bytes. It does not rebuild, install SDK dependencies or run SDK tests with publishing
credentials. Actions and npm are pinned, and dependency lifecycle scripts are disabled.

Only the publisher receives `id-token: write`. It uses GitHub-hosted runners, Node 24,
npm 11.19.0 and the `npm` environment. npm trusted publishing must match all of:

- Package: `@daoships/sdk`
- Repository: `DAO-Ships/daoships-sdk`
- Workflow filename: `release.yml`
- Environment: `npm`
- Permission: publish

The environment permits release tags only. The publisher also requires repository
variable `NPM_TRUSTED_PUBLISHING_ENABLED=true`; removing it disables uploads without
removing validation. No persistent npm publishing token is stored in GitHub.
See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) and the
[npm trust CLI](https://docs.npmjs.com/cli/v11/commands/npm-trust/).

## Initial bootstrap and verification limits

The initial release was uploaded from the retained archive with
`npm publish .release/daoships-sdk.tgz --ignore-scripts --access public --tag alpha`,
after npm's browser authentication. Later tags use the OIDC workflow described above.
The existing `v0.1.0-alpha.0` tag retains its original workflow and package contents.

Configuration and validation alone do not prove an OIDC upload works. The first new
version published by GitHub must be checked for registry integrity and provenance.
Release workflows do not deploy contracts, apply database migrations or execute funded
Orchard transactions. Those acceptance limits remain documented separately.
