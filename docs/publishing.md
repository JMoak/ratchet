# Publishing plan

Reviewed 2026-10-20 against this checkout. **Planning only: neither the npm package nor a
hosted arcade is ready to release.** No release configuration, registry settings, accounts,
license, or deployment has been changed by this plan.

Keep the engine and CLI in one small package. Treat the arcade as a separate deployment
of the examples. Releasing the library does not require operating a paid model service.

## Decisions for the owner

| Decision | Proposed starting point | Still needed |
| --- | --- | --- |
| Package identity | An owner-controlled scope with the working name, such as `@<owner>/ratchet` | Confirm the final name, scope ownership, registry availability, and whether the CLI stays `ratchet`. No name is reserved by this document. |
| License | One explicit license for the code | Choose the terms and copyright holder; add `LICENSE` and matching package metadata. Review separately any third-party material retained in the repository or distributed. |
| Runtime contract | ESM JavaScript and declarations; support Bun first | Decide whether the first release also supports Node. Set minimum versions from consumer tests. Browser and CommonJS support are separate work. |
| Release version | An explicit prerelease, published under an intentional dist-tag | Reconcile manifest `0.0.1` with the README's 0.2 feature milestone; choose the actual version and tag. |
| Hosting | A Bun process serving the arcade and its API on the same origin, offline judges by default | Choose provider, domain, operating budget, and who operates it. Live Jev access needs a separate hosting decision. |

## What blocks the package today

| Inspected area | Current state | Release work |
| --- | --- | --- |
| Publication switch | `package.json` has `"private": true` | Keep it until the release candidate is approved; change it deliberately for publication. |
| Library entry | Public API is `src/index.ts`; no `exports`, `main`, or `types` fields | Expose a built root entry with declarations. Do not advertise deep imports into internal files. |
| Build | `tsconfig.json` checks the entire repository with `noEmit`; source imports end in `.ts` | Add a separate release build scoped to `src/` and `bin/`, emitting JavaScript and `.d.ts`. |
| CLI | `bin/ratchet.ts` uses `#!/usr/bin/env bun` | Point `bin.ratchet` at the emitted CLI; retain a Bun requirement or provide a tested Node launcher. Check Windows shims too. |
| Package contents | No `files` allowlist; `.gitignore` excludes secrets and generated data but is not a release manifest | Allowlist the distributable files and inspect the packed archive. Keep research, experiments, local ledgers, keys, tests, and arcade assets out of the library package. |
| Metadata | No license, repository, homepage, bugs, or supported-engine fields | Add owner-approved metadata. The checkout's remote is `https://github.com/JMoak/ratchet`; confirm this remains canonical. |
| Consumer documentation | Examples import `./src/index.ts` and run from the checkout | Add installed-package and CLI examples once the identity is chosen. Keep source-checkout instructions. Check links on npm as well as GitHub. |
| Release validation | No build/pack/consumer workflow in the tree | Validate the actual tarball in fresh projects; repository tests alone do not exercise published resolution or declarations. |

npm's [`package.json` reference](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/)
documents entry points, package contents, metadata, and the private flag. The allowlist
needs particular care: README, license, and executable entries receive special treatment.

### Proposed package shape

Use an unbundled ESM build initially. Preserving the source layout makes the package easy
to inspect and avoids another build dependency:

```text
package.json
README.md
LICENSE                     owner-selected, not present yet
dist/
  src/index.js              package root runtime entry
  src/index.d.ts            package root type entry
  src/...                   emitted modules and declarations
  bin/ratchet.js            installed CLI
```

The future manifest would set `type: "module"`, a root `exports` mapping with `types` and
`import` targets, a top-level `types` field, `bin.ratchet`, and `files: ["dist"]`. Add `main`
only if required by the chosen consumer support. A build config can use repository
`rootDir`, `outDir: "dist"`, `noEmit: false`, `declaration: true`, and
`rewriteRelativeImportExtensions: true`; TypeScript supports rewriting relative `.ts`
imports in emitted JavaScript. Validate declaration resolution as well.
[TypeScript option reference](https://www.typescriptlang.org/tsconfig/rewriteRelativeImportExtensions.html)

The core currently imports `node:crypto` and `node:fs/promises` through its ledger, and
adapters read environment variables. It is a server library; using `MemoryLedger` does
not make the root entry browser-compatible. No `Bun.*` calls were found in `src/`, but
that is a reason to test Node support, not a compatibility result. A Node release also
needs an appropriate emitted CLI shebang and type checking without the repository's
Bun globals. Shipping raw TypeScript would not solve this: Node does not strip types
from dependencies under `node_modules`.
[Node TypeScript documentation](https://nodejs.org/api/typescript.html#type-stripping-in-dependencies)

## Package release stages

1. **Set the contract.** Resolve identity, license, supported runtimes, version, and tag.
   Add a short changelog describing the experimental API and current rollout limitations.
   Preserve the warning that observed accuracy is not statistical certification.
2. **Implement locally.** Add the build, entry points, allowlist, metadata, and installed
   examples described above. Keep zero runtime dependencies. Keep publication disabled
   while reviewing the candidate.
3. **Validate the archive.** From a clean checkout, use the pinned Bun version and frozen
   lockfile, then run `bun run check` and the new release build. Run
   `bun pm pack --dry-run --ignore-scripts` to inspect inclusion, then create a tarball
   with `bun pm pack`. Check its file list, size, entry paths, executable, declarations,
   license, and absence of `.env*`, credentials, raw datasets, and local output.
   Dry-run packing lists contents without writing a tarball.
   [Bun packing documentation](https://bun.com/docs/pm/cli/pm#pack)
4. **Test installation.** Install that exact tarball into fresh Bun/TypeScript consumers
   outside this checkout, without workspace links or access to its `node_modules`.
   Import the root API; run a deterministic gate; append, label, and reopen a JSONL ledger.
   Type-check with `skipLibCheck: false`. Exercise installed `ratchet report`, `check`,
   and `replay`, including success, failed check, and usage-error exit codes. Test the
   minimum claimed runtime and Windows/Linux command launch. If Node is promised,
   repeat with Node and a normal npm install. No paid model call is needed.
5. **Review the candidate.** Record source revision, archive hash/file list, check results,
   runtime matrix, version/tag, and release notes. Repair the build and repack if anything
   changes. A publish dry run is an additional check, not an installed-package test.
6. **Publish only when authorized.** The owner commits and tags. Use the reviewed artifact
   and explicitly selected registry, access, and dist-tag. Verify the installed registry
   artifact afterward. A published name/version cannot be reused, even after unpublishing;
   corrections require a new version.
   [npm publishing reference](https://docs.npmjs.com/cli/v11/commands/npm-publish/)

For eventual automation, prefer a GitHub-hosted release workflow using npm trusted
publishing. Current requirements include npm CLI 11.5.1+, Node 22.14.0+, an exact
repository/workflow binding, and `id-token: write`. Bun can remain the install/build/test
tool. Decide who performs initial package setup and configure only the intended publishing
actions; newer trusted-publisher configurations distinguish staging from direct publication.
For a public repository/package, verify the generated provenance after release.
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)

Do not assume `bun publish` supplies the same provenance path: Bun's current documentation
says provenance generation is unsupported. Manual publishing and its authentication remain
an owner-operated alternative.
[Bun publishing documentation](https://bun.com/docs/pm/cli/publish)

## Hosted arcade: a separate release

The arcade's pages call `/api/orchard`, `/api/bridge`, `/api/parcels`, and `/api/treasure`.
Those routes execute the engine in `examples/arcade/server.ts` via `Bun.serve`; static
HTML alone cannot play the games. GitHub Pages serves static files, so it can host a
landing page or documentation, but the present arcade needs a server or a deliberate
browser-port project.
[GitHub Pages documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages)

The current server binds to `127.0.0.1` and rejects non-local hostnames. Its JSON limits,
route allowlist, and same-origin checks are useful local boundaries, not a hosted-service
configuration. Deployment must account for those checks explicitly.

| Stage | Work before a public URL |
| --- | --- |
| Package the server | Pin Bun; include the arcade assets and engine source/build in an explicit deploy artifact. Exclude `.env`, datasets, local ledgers, and research. Verify asset resolution from the deployed directory. |
| Configure hosting | Add explicit host, port, and public-origin configuration; retain loopback defaults for local use. Honor the host's port contract, configure TLS and a health check, and test reverse-proxy origin handling without trusting arbitrary forwarded headers. |
| Validate offline play | Keep live mode disabled. Smoke-test all four pages, autonomous turns, stop/reset, API errors, request-size bounds, cross-origin rejection, and ledger downloads on the deployed candidate. Verify a restart recovers service. |
| Enable live play separately | Keep keys in server-side host secrets. Decide who may spend money and add access controls, rate/concurrency limits, and a durable shared usage counter. Confirm the applicable provider terms for a public demo. Browser origin checks are not authentication. |
| Operate and recover | Choose retention for request logs, avoid logging secrets or unnecessary state, set provider-side limits where available, and document disable-live, rollback, and shutdown procedures. Preview and production need separate configuration. |

`ARCADE_LIVE=1` plus a server key enables the local live option. Its request/spend tracking
and replay cache live in process memory: restart or additional workers reset or multiply
them. The cutoff counts reported cost after requests; concurrent or unsuccessful calls
can incur charges that it cannot reserve in advance. Those local controls are not a
durable hosted billing limit. Keep the first public arcade on offline judges until the
live hosting contract is implemented and reviewed.

## Ready means

- **Package:** owner decisions recorded; license selected; built archive inspected; fresh
  consumers pass; runtime support and release limitations documented; release artifact
  reviewed and publication explicitly authorized.
- **Arcade:** chosen host runs the actual server; public-origin and deployment checks pass;
  all four games work; live mode is either disabled or has its own approved access and
  spending controls; rollback has been exercised.

This document prepares the work. It does not certify either release candidate or change
the engine's [evidence requirements](roadmap.md).
