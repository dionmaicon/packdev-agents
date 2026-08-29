# Architecture

Both deployment modes in [`use-cases.md`](use-cases.md) run the same loop:

```
dependabot PR opened
  -> extract the bump (package, from, to)
  -> prepare a workspace at the PR's BASE ref
  -> run `packdev api-diff` (static, no install) as a fast pre-check
       -> confident negative? report STATIC_INCOMPATIBLE, skip compat entirely
       -> otherwise (compatible, or unresolved/dynamic usage): fall through
  -> run `packdev compat` against it
  -> interpret the report into a verdict
  -> report the verdict back on the PR
```

Only two things differ between modes: what triggers step 1 and where steps
2-4 execute, and which model backend step 5 uses for prose. Everything else
is one implementation.

## What we consume

`packdev` v0.4.2, published on npm, `engines.node >= 18`. It carries two
unrelated toolsets. The original local-dev dependency-linking commands
(`init`, `finish`, `add`, `remove`, `list`, `status`, `link`, `watch`,
`restore`, `create-config`, `setup-hooks`, config file `.packdev.json`) are
not used here at all. We consume only the dependency-testing side:

| Command | Use to us |
| --- | --- |
| `compat` | The primary verdict. Sandboxed install + real test run per version. |
| `api-diff` | Static pre-filter, run before `compat`. No install — see below. |
| `dupes` | Duplicate-copy detection, folded into every `compat` run via `--check-dupes`. |
| `api` | Export map of the installed version. Diagnostic only. |
| `behavior-diff` | Experimental. Not used in v1. |

`--json` is a global flag on the program, not per-command: stdout is pure
JSON, all progress goes to stderr.

### Shell out, do not import

`packdev`'s `package.json` sets `"main": "dist/index.js"` and ships no
`exports` map — but that file *is* the CLI entry, and it calls
`program.parse()` as a side effect at module load. Requiring `packdev`
executes the CLI. `runCompat`/`runCompatBisect`/`runApiDiff` are real
exported functions and types ship as `dist/*.d.ts`, so a deep import would
technically work, but that is undocumented surface with no stability
guarantee.

The orchestrator therefore spawns the CLI and parses `--json` stdout. That
is the actual contract. We pin `^0.4.2` and re-verify the report interfaces
on any packdev minor bump, since no versioned JSON schema is published — the
TypeScript interfaces in packdev's source are the contract.

### Exit codes

From `packdev/src/index.ts`:

```
0 SUCCESS                 4 PACKAGE_NOT_INSTALLED
1 GENERIC_ERROR           5 DUPLICATE_FOUND
2 CONFIG_NOT_FOUND        6 NOTHING_TESTED
3 PACKAGE_JSON_NOT_FOUND  7 COMPAT_FAILED
```

Two traps:

- `exitCodeFor()` maps thrown errors to codes by **regex on the message
  text**, not by a typed error. `compat`'s "not declared in the app's
  package.json" error does not match `/is not installed/i`, so it exits **1**,
  not 4. Do not treat exit 4 as covering the undeclared-dependency case for
  `compat`.
- Exit 6 (`NOTHING_TESTED`) is not a pass. It means every candidate came back
  `SKIPPED` and nothing was determined.

## The control problem

`compat` tests the currently-installed version alongside the candidates as a
**control**: if the control does not pass, the app's own test harness is
broken and no verdict about the candidate is meaningful.
`minimumCompatibleVersion`/`recommendedVersion` are forced to `null` in that
case, and `controlFailed` is set.

The control version is resolved from **node_modules**, never from
`--versions`/`--range`:

```ts
// packdev/src/compat.ts
async function resolveControlVersion(pkgName, appDir) {
  const dir = await resolveInstalledPackage(pkgName, appDir);
  if (!dir) return null;
  return getInstalledVersion(dir);
}
```

and `resolveControlResult` reuses an already-tested candidate when the
versions coincide:

```ts
const existing = alreadyTested.find((v) => v.version === controlVersion);
if (existing) return existing;
```

This produces two silent degradations, both of which look green:

1. **No node_modules in the workspace.** `resolveControlVersion` returns
   `null`, so `control` is `null` and `controlFailed` is `false`. In the JSON
   this is indistinguishable from a healthy run whose control passed. Anything
   branching on `controlFailed` reads "harness fine" when no control ever ran.
2. **Installing from the PR head.** On a Dependabot PR the package.json is
   *already bumped*, so node_modules holds the very version under test. The
   `alreadyTested` short-circuit fires and the control becomes the candidate.
   `controlFailed` then just mirrors the candidate's own status. The guard is
   dead, silently.

The naive CI recipe — checkout the PR, `npm ci`, run compat — hits case 2 every
time.

### Consequence: prepare at the base ref

The workspace must be checked out and installed at the PR's **base** ref, so
node_modules and package.json are pre-bump. Then:

```
packdev compat <pkg> --versions <toVersion> --test "<cmd>" --json
```

gives `control` = the old version and the candidate = the new one, which is
exactly the question Dependabot is asking. `compat` pins the candidate inside
its own throwaway sandbox copy, rewriting whichever dependency section
declares the package, so the base ref declaring the old range is fine.

Cost is therefore a minimum of two sandboxed installs per run (control +
candidate), not one.

The orchestrator asserts `report.control !== null` after every run. A null
control is treated as an infrastructure failure, not as a verdict.

## Core

`src/core/` is trigger-agnostic and model-agnostic. No adapter imports
anything GitHub-specific or model-specific from here; dependencies point
inward only.

### 1. `extractBump(pr) -> Bump | Unsupported`

`{ name, fromVersion, toVersion, section, packageJsonPath }`, read from the
**package.json diff**, not the PR title — titles are formatted by the bot
and vary between Dependabot and Renovate, ecosystems, and grouped-update
configs.

`packageJsonPath` is auto-discovered by default: every `package.json` that
actually changed between the PR's base and head is found via `git diff
--name-only`, and each is checked for a real dependency-version change. A
monorepo with more than one independently-Dependabot-tracked workspace
member needs this — each member gets its own PR touching a different file,
so a single fixed path can't work past the first tracked package. An
explicit path can still be passed to pin scanning to one file, which is
useful for narrowing scope in a repo with unrelated `package.json` churn
elsewhere, but it's an override, not the default.

Grouped bumps — more than one dependency version changed, whether within one
file or spread across several files at once — return `Unsupported` in v1 and
are reported as such, listing every bump found. Guessing which one to test
would produce a verdict that does not answer the PR.

### 2. `prepareWorkspace(baseRef) -> Workspace`

Checkout base, detect the package manager (packdev reads `packageManager`
then the nearest lockfile — we match that so our install agrees with its
sandbox install), run a real install.

This step is the control guard. It is not an optimization to skip it.

### 2.5 `runApiDiff(appDir, bump) -> ApiDiffReport` — static pre-filter

Spawn `packdev api-diff <name> --range <bump.toVersion> --app . --json` (a
bare version string is itself a valid semver range matching only that
version). Static — no sandboxed install — so this always runs before the
expensive per-version `compat` sandbox.

`interpret()`'s `Verdict` union only ever describes an outcome that came
from a real `compat` run, so this is deliberately its OWN
`RunGithubPipelineResult` status (`static-incompatible`), not folded into
`Verdict` — mirrors the existing `unsupported-bump` short-circuit pattern
rather than forcing a report shape that never ran a real test into the
verdict machinery that assumes one did.

Short-circuits — skips `compat` entirely — only on a CONFIDENT negative:

```
candidate.apiCompatible === false && !report.hasDynamicUsage
```

`apiCompatible` is tri-state (`boolean | null`): `null` means "could not
verify" (unresolved barrel re-export, types-package fallback) and must
never be treated as either a pass or a failure. `hasDynamicUsage` is true
when the app uses the package via a namespace import or bare `require()`
that the static scan can't enumerate exact symbols for — `usedSymbols`
under-reports in that case, so a `true`/`false` conclusion from it can't be
trusted either way. Every other combination (compatible, dynamic usage, or
unresolved) falls through to the real `compat` run unchanged — this pre-filter
only ever short-circuits toward a confident rejection, never toward a pass.

### 3. `runCompat(workspace, bump) -> CompatReport`

Spawn the CLI with `--json`, parse stdout. Capture stderr separately for
diagnostics. Always passes `--check-dupes --seed-lockfile`: dupes checking
runs against installs `compat` already performs (no added cost), and
`--seed-lockfile` is packdev's own recommended pairing for it — without it a
fresh solve can re-flatten away exactly the nested-fork duplicate class
`--check-dupes` exists to catch. `report.ts` already renders `dupesRegression`
verbatim on any verdict kind that carries one. Relevant fields:

- `versions[]`: `{ version, status, exitCode, durationMs, output?,
  lockfileHash, dupeCounts?, dupesRegression?, esmMismatch?, consumers? }`
  with `status` one of `PASSED | FAILED | INSTALL_FAILED | SKIPPED`
- `control`, `controlFailed`
- `testCommandCaveats[]`: `{ code, severity, message }`, `code` one of
  `TRANSPILE_ONLY | TYPE_CHECK_ONLY | PASS_WITH_NO_TESTS`
- `sandboxMode` (`hermetic | workspace`), `packageManager`,
  `minimumCompatibleVersion`, `recommendedVersion`, `nonMonotonic`

`CompatBisectReport` extends this with `bisected`, `testedVersionCount`,
`totalVersionCount`, `fellBackToLinearScan`. We do not use `--bisect` in v1:
a Dependabot PR has exactly one target version, so there is no range to
search.

### 4. `interpret(report, exitCode) -> Verdict`

Explicitly **not** a zero/nonzero exit check. Precedence, highest first:

| Condition | Verdict | Blame |
| --- | --- | --- |
| `control === null` | `NO_CONTROL` | our infra |
| `controlFailed` | `HARNESS_BROKEN` | the app's test setup |
| any `INSTALL_FAILED` | `INSTALL_FAILED` | registry/auth/PM, not the bump |
| exit 6, or all `SKIPPED` | `NOTHING_TESTED` | nothing determined |
| candidate `FAILED` | `INCOMPATIBLE` | the bump |
| `PASSED` + caveats | `PASSED_WEAK` | — |
| `PASSED` | `PASSED` | — |

`HARNESS_BROKEN` and `INSTALL_FAILED` must never be reported as the bump
being incompatible. `NOTHING_TESTED` must never be reported as a pass.

`PASSED_WEAK` exists because `testCommandCaveats` are structural: a
transpile-only jest transform (`ts-jest` `isolatedModules`, `babel-jest`,
`@swc/jest`) never reads the dependency's types at all, and a bare
`tsc --noEmit` sees only type breaks — both can report `PASSED` over a real
incompatibility. Caveat text is always surfaced verbatim in the PR comment
and always blocks auto-merge.

If `api-diff` is run as a pre-check, `apiCompatible` is **tri-state**:
`null` means "could not verify" and is never treated as either a pass or a
failure. `hasDynamicUsage: true` means the static scan could not enumerate
symbols (namespace import or bare `require`), so `usedSymbols` under-reports
and `api-diff` is weak evidence for that repo — defer to `compat`.

### 5. `report(verdict) -> void`

Renders the verdict, then hands it to an adapter-supplied sink. The renderer
is shared; only the sink differs.

## Adapters

### GitHub mode — `src/adapters/github-action/`

Trigger `pull_request`, gated on `github.actor`. Sink: a check run plus a PR
comment, and optionally auto-merge/auto-close driven by the verdict — never
by the raw exit code. Only `PASSED` is auto-merge eligible; `PASSED_WEAK` and
everything below require a human.

Needs `fetch-depth` sufficient to reach the base ref, since
`prepareWorkspace` checks it out.

### Self-hosted mode — `src/adapters/selfhosted/`

Polls `GET /repos/:owner/:repo/pulls`, filters for new bot PRs, tracks seen
PRs so a restart does not re-comment. Same core, same renderer; sink posts
via the user's own `gh` token. Webhook relay stays deferred per
[`use-cases.md`](use-cases.md).

## Model backend

One `Brain` interface, implementations for a hosted API and for a local
OpenAI-compatible endpoint (Ollama, vLLM).

In v1 the model's scope is deliberately narrow: **summarizing failure output
into a readable PR comment**. It does not decide pass/fail. packdev already
produces a deterministic verdict, and `interpret()` is a pure function over
that report — keeping the merge decision out of the model means the decision
is reproducible, auditable, and identical whether the user runs Claude or a
7B local model. A degraded or unavailable model degrades the comment prose,
never the verdict.

## Known limitations to carry into the reports

- **Monorepos.** `extractBump`'s auto-discovery (see "core / extractBump"
  above) resolves the historically most common "reports nothing useful"
  case — a bump declared in one workspace member's package.json no longer
  needs a caller-supplied path pointing at the right member; the diff itself
  tells us where it lives, and the compat sandbox is run from there.
  Genuinely remaining: bumping a dependency that OTHER workspace members
  consume only via a local `workspace:` link to the bumped member (not the
  bumped package directly) isn't tested by v1 — only the member whose own
  package.json declared the bump is checked. `--fan-out` from the monorepo
  root exists in packdev for exactly this and is future work to wire up
  here.
- **`nonMonotonic`** on a linear scan means pass/fail was not contiguous
  across versions, so `minimum`/`recommended` may not mean what they appear
  to. Not reachable in v1's single-version runs, but must be handled if we
  ever widen to a range.
- **No aggregate timing** in the JSON. `durationMs` is per-version, covering
  install plus test. Wall clock is dominated by the real package-manager
  install and the app's own test suite.
- **No published JSON schema.** The report shape is a source-level contract.
  Pin packdev tightly and re-verify on bumps.
