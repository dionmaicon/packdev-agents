# packdev-agents

Automated dependency-update triage: when Dependabot (or Renovate) opens a PR,
an agent runs [`packdev`](https://github.com/dionmaicon/packdev) compat checks
against the bumped dependency, then reports a verdict back on the PR — comment,
check run, or auto-merge/close, depending on configuration.

This repo is intentionally separate from `packdev`. `packdev` stays a focused
CLI/MCP tool for dependency compatibility testing; this repo consumes it as a
published npm package and adds orchestration (triggers, sandboxing, LLM
integration) on top.

## Status

Early scaffolding. No working code yet — see `docs/use-cases.md` for the
two deployment modes being designed, and `docs/architecture.md` for how they
share a common core.

## Modes

- **GitHub mode** — ships as a reusable GitHub Action. Zero infra for the
  user beyond a workflow file and an LLM API key.
- **Self-hosted mode** — runs on the user's own infra (local model, no data
  leaves their network). Starts with polling (zero infra); a hosted
  webhook relay is a possible v2.

See `docs/use-cases.md` for details.

## Relationship to packdev

Results and links from this repo get referenced back from `packdev`'s docs
once a use case is working and tested — this repo does not get folded back
into `packdev`.
