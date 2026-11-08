# Dependency maintenance

Dependabot maintains the root `package.json` and text `bun.lock` using the native Bun
ecosystem, and scans `.github/workflows` for GitHub Actions updates. The repository has
no runtime dependencies; its five package dependencies are development tools.

Version checks run on Tuesdays at 09:00 America/New_York for Bun and 09:30 for Actions.
Patch and minor updates are grouped by ecosystem; major updates stay in individual PRs
so their migration notes and compatibility can be reviewed separately. New patch,
minor, and major versions wait 3, 7, and 14 days respectively before becoming eligible.
Each ecosystem is limited to five open version-update PRs. GitHub Actions security updates
use a separate group and are not delayed by the version schedule or cooldown. Dependabot
does not currently support Bun security-update PRs; an advisory affecting the Bun tree
requires a maintainer update even though regular version updates are automated.

PRs use `chore(deps)` commit messages and are reviewed before merging. There is no
automatic merge. Dependency updates do not bump the package version or bypass npm's
staged approval. A merge to main still invokes the existing release workflow: it skips a
version already published on npm, but may stage the current manifest version if that
version is not yet public. Repeated pushes of a still-staged version can fail until the
owner approves it; dependency maintenance does not change that release behavior.

The `check (types, lint, tests, build, pack)` job installs the frozen lockfile,
runs type checking, lint and tests, builds the package, starts the emitted CLI under Node,
and checks the package contents. On PRs it also runs `bun audit --audit-level high` against
the complete locked dependency tree, including development dependencies. The PR-only
`dependency review` job rejects introduced
high or critical vulnerabilities in runtime, development, and unknown dependency scopes.
It uses a pinned action and read-only repository permission, with no PR comments or
package installation. No license allowlist is imposed by this change.

GitHub's dependency review consumes its dependency graph. Its documented static inputs
include `package.json` but currently do not include `bun.lock`, so this check must not be
treated as complete coverage of Bun's transitive dependencies. The Bun audit step fills
that gap for known high and critical advisories and can also fail when an existing locked
version receives a new advisory. Repair the dependency or investigate the advisory before
merging; do not make the check advisory-only to pass a PR. Keep reviewing the lockfile
diff and Dependabot alerts. The native Bun updater maintains the lockfile independently
of the dependency-review API's coverage.

Repository administrators should enable the dependency graph, Dependabot alerts and
Dependabot security updates, and require both CI jobs in the main-branch ruleset.
The YAML config does not enable those repository settings or make checks required.

When reviewing a dependency PR:

1. Check the upstream changes and the manifest/lockfile diff; preserve zero runtime
   dependencies and the Node/Bun runtime contract.
2. Require the CI checks to pass, including the packed Node CLI smoke test. Test breaking
   tooling updates individually before combining them with routine updates.
3. Merge the reviewed update without a release-version bump. Choose a new version and
   changelog entry separately when intentionally shipping a package release.

References: [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference),
[Bun support](https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories#bun),
[dependency graph inputs](https://docs.github.com/en/code-security/reference/supply-chain-security/dependency-graph-supported-package-ecosystems),
and [dependency review](https://github.com/actions/dependency-review-action).
