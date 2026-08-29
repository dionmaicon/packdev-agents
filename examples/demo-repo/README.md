# packdev-agents demo

A minimal real app whose only purpose is to be a live Dependabot target
for `packdev-agents`' GitHub Action. It depends on `is-odd` pinned to an
old exact version so Dependabot has something real to bump, and has one
real test that exercises the dependency's actual behavior.

## What's wired here

- `.github/dependabot.yml` — npm ecosystem, daily schedule.
- `.github/workflows/packdev-compat.yml` — runs on every PR authored by
  `dependabot[bot]`, invoking `dionmaicon/packdev-agents@main` with
  `test-command: npm test`.

## To make this a live demo

This directory is scaffolding checked into the `packdev-agents` repo
itself, not yet a running demo. Turning it into one requires two things
outside what this repo alone can do:

1. `packdev-agents` itself needs to be pushed to `github.com/dionmaicon/packdev-agents`
   so the `uses: dionmaicon/packdev-agents@main` reference in the
   workflow above resolves to something real.
2. This directory's contents need to be pushed to its own public repo
   (or kept as a subdirectory workflow target — GitHub Actions can run
   against a monorepo subdirectory just fine, but Dependabot's
   `directory: "/"` in `dependabot.yml` is repo-root-relative, so a
   clean separate repo is simpler) with Dependabot enabled and at least
   one open PR — which happens on Dependabot's own schedule once
   enabled, not on demand.

Both are real, visible actions on a GitHub account and were left for
an explicit go-ahead rather than done automatically. See
`docs/architecture.md` for the design this demo is meant to prove out,
and `test/core/pipeline.test.ts` for the same verdict scenarios
(PASSED, INCOMPATIBLE, HARNESS_BROKEN, PASSED_WEAK) already proven
against the real core pipeline and a real packdev run, just not
through an actual GitHub PR yet.
