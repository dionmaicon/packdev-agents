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

Grouped bumps — more than one dependency version changed within a PR — are
now supported for the common real case: Dependabot's own "grouped update"
for a version-locked family (e.g. every `@nestjs/*` package moving to the
same release together, real-world verified via a live PR on
`packdev-demo-nestjs`). Detected as: multiple bumps found in the SAME
`package.json`, ALL landing on the exact same `toVersion`. One bump is
picked as the primary (deterministic, sorted by name — not insertion
order), the rest become `Bump.group`, passed to `packdev compat --group`
so the sandbox pins them together — testing the primary alone while its
peers silently stayed on the old version would not answer the PR, and (see
"The control problem" above) was the exact real bug this closes: an
earlier real run bumping `@nestjs/core` alone, without its `@nestjs/common`
peer, produced a genuine runtime break that a grouped test correctly
avoids by construction.

Still `Unsupported`, and reported as such listing every bump found: bumps
spread across MORE THAN ONE `package.json` (a monorepo can have this), or
bumps within one file landing on DIFFERING target versions — packdev's
`--group` can only pin companions to the exact same version string as the
primary being tested, not to their own independent target, so a
heterogeneous grouped update genuinely can't be expressed as one compat
run. Guessing which one to test in that case would produce a verdict that
does not answer the PR.

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
verbatim on any verdict kind that carries one. Also passes `--group
<names>` when `bump.group` is populated (see "core / extractBump" above) —
pins those companions to the same candidate version being tested. Relevant fields:

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

### Agentic triage (experimental) — `src/adapters/agentic-triage/`

A genuinely different adapter shape, not a mode of the two above: instead
of a fixed, deterministic sequence (`extractBump -> compat -> interpret ->
report`), a real coding-agent tool-use loop decides for itself which of
packdev's own tools to call and in what order, using `packdev mcp`
(packdev's own MCP server — stdio, local-only, "never uploads your
dependency tree") as the tool surface.

```
mcpClient.ts   connectPackdevMcp(cwd) -> spawns `packdev mcp`, wraps the
               real @modelcontextprotocol/sdk Client + StdioClientTransport.
agentLoop.ts   ONE `AgentLoop` interface (same "one interface, N backend
               factories" shape as Brain below), two real implementations:
               createAnthropicAgentLoop (Anthropic Messages API, raw fetch,
               tool_use/tool_result content blocks) and
               createOpenAiCompatibleAgentLoop (OpenAI chat/completions
               wire format: tools nest under {type:"function", function:
               {...}}, results come back as tool_calls[] with arguments as
               a JSON STRING not an object, and tool results are separate
               role:"tool" messages keyed by tool_call_id — genuinely
               different message plumbing, not just a different base URL).
               Both drive the same loop shape: send prompt + tools, execute
               whatever tool calls come back via executeTool, feed results
               back, repeat until the model stops asking for tools or
               maxTurns is hit.
triage.ts      runAgenticTriage(bump, appDir, agentLoop) -> wires an
               AgentLoop + mcpClient together for one bump: connect, list
               tools, run the loop, close.
pipeline.ts    runAgenticTriagePipeline(...) -> the surrounding plumbing
               (actor gate, extractBump, prepareWorkspace at the base ref
               — same as core/pipeline.ts) around triage.ts, posting an
               ADVISORY comment under its own marker
               (AGENTIC_TRIAGE_COMMENT_MARKER, distinct from
               COMMENT_MARKER) and an always-neutral check run.
```

Not Anthropic-only by design: `createOpenAiCompatibleAgentLoop` is the same
backend that already covers hosted OpenAI and local Ollama/vLLM for
`Brain`, and it's what makes a genuinely different model family testable
here — verified for real against Z.ai's GLM Coding Plan endpoint
(`https://api.z.ai/api/coding/paas/v4` — note this is the coding-plan-specific
path, NOT `/api/paas/v4`, which is the separate pay-as-you-go endpoint;
using the wrong one is a documented gotcha) with `glm-5.3-flash`. Z.ai's
tool-calling format is genuinely OpenAI-shaped (`tools`/`tool_calls`), not
a translation shim, so this exercises the real second wire format, not
just a second URL.

**Trigger gotcha, hit live and worth documenting:** GitHub Actions
workflows triggered by Dependabot's `pull_request` event run read-only and
WITHOUT repository secrets — a platform restriction, not a bug in this
code (Dependabot PRs are treated like fork PRs for secret access; the main
`compat` job never hit this because it only ever needed the
auto-provided `github.token`, never a custom secret). The documented
GitHub-sanctioned workaround is `pull_request_target` for the job that
needs a secret — it runs with base-branch trust, but its default
`github.ref`/checkout resolves to the BASE branch, not the PR, so
`agentic-triage-action/action.yml`'s checkout step sets
`ref: ${{ github.event.pull_request.head.sha }}` explicitly (safe on
either trigger — that field exists on both events' payloads). The two
demo repos run agentic-triage from its own workflow file on
`pull_request_target`, not the same file as the `pull_request`-triggered
`compat` job, since a workflow's trigger type is file-wide, not
job-wide, and there was no reason to touch the already-working `compat`
job's trigger to fix this. Since the actor gate (`dependabot[bot]` only)
already applies, this is the same trust boundary GitHub's own docs
recommend for "Dependabot needs secrets" — not a wider exposure.

**Cost/hang safeguards, also hit live:** a stuck provider (accepts the
connection, never responds) has nothing local to catch it — `agentLoop.ts`
now wraps every model API request in `AbortSignal.timeout()`
(`requestTimeoutMs`, default 90s), which fails fast with a clear "provider
appears stuck, not just slow" error instead of hanging. That is a
per-request guard, not a whole-run budget, so it is NOT the actual CI-cost
backstop — `agentic-triage-action/action.yml`'s top comment explicitly
tells callers to set `timeout-minutes` on the JOB (a composite action
can't set this on itself), since a provider that keeps responding just
slowly enough to dodge each per-request timeout would otherwise keep
billing CI minutes indefinitely. Separately: `max_tokens` defaults to 8000
(`maxOutputTokens`, tunable per call) after a real run against a genuinely
incompatible bump hit the old 2000 default — some models (Z.ai's GLM
Coding Plan models observed doing this) spend a large, invisible token
budget on chain-of-thought reasoning before the visible response even
starts, so too low a budget cuts the response off with `finish_reason:
"length"` and ZERO visible content, which surfaces as a hard error, not a
truncated-but-usable report.

Deliberately kept OUT of `interpret()`'s `Verdict` union and out of
auto-merge eligibility entirely: this is the ONLY place in the repo where
a model gets to decide what to DO next, not just what to say, and that is
exactly the property that must never leak into the deterministic,
reproducible pipeline the rest of the system is built around. Meant to run
ALONGSIDE the main `packdev compat` action on the same PR
(`agentic-triage-action/action.yml`, a separate composite action, not a
mode flag on `action.yml` at the repo root — this repo already chose
"separate concerns, separate actions" over a shared entrypoint once
before, for the demo-repo split; this follows the same call), never
replacing it.

Real, non-mocked test coverage: `mcpClient.test.ts` spawns the actual
`packdev mcp` subprocess and calls its real tools; `agentLoop.test.ts`
fakes only the external boundary (a local HTTP server standing in for
each backend's real API, same pattern as `brain.test.ts`) and drives a
real multi-turn tool-use exchange against both the Anthropic and
OpenAI-compatible wire formats; `triage.test.ts` and `pipeline.test.ts`
combine both — a real `packdev mcp` server plus a scripted fake model —
to prove the whole chain actually connects, down to asserting the tool
result fed back to the model is packdev's genuine JSON report, not a
stub. `liveZai.test.ts` goes one step further and is NOT faked at all:
a real call to the real Z.ai API, skipped (not failed) whenever no
`ZAI_API_KEY` is available, so it never breaks CI or a machine without a
subscription, but proves real GLM behavior in the loop whenever the key
is present.

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
