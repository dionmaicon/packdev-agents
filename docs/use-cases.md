# Use cases

Two deployment modes for the same core loop: **dependabot PR opened → packdev
compat check runs → verdict reported back on the PR.** They differ in where
the agent runs, what triggers it, and what it thinks with.

## Mode 1: GitHub mode

Runs entirely inside GitHub's own infra.

- **Distribution**: published as a reusable action in a public actions repo
  (e.g. `packdev-actions/compat-check@v1`).
- **Trigger**: `pull_request` event, gated on
  `github.actor == 'dependabot[bot]'` (or the Renovate bot equivalent).
- **Execution**: GitHub-hosted runner checks out the PR branch, runs
  `packdev compat` (or `api-diff`) against the bumped dependency.
- **Brain**: hosted LLM API (Anthropic/OpenAI/etc.) via the user's own API
  key, supplied as a repo secret.
- **Output**: PR comment, check run, and/or auto-merge/auto-close based on
  packdev's exit code (e.g. exit 7 = COMPAT_FAILED, exit 6 = NOTHING_TESTED).
- **Who it's for**: solo devs, small teams — anyone fine with GitHub Actions
  minutes plus API token cost. Effectively "Dependabot with a compat-testing
  brain attached."
- **Effort to ship**: low. This is the first thing to build and demo.

## Mode 2: Self-hosted mode

Runs on the user's own infra. No code, dependency manifests, or diffs leave
their network; the "brain" can be a local model (Ollama, vLLM, etc.) instead
of a hosted API.

Not every user has a public webhook endpoint or a VPS, so the trigger can't
assume inbound connectivity. Two options, in order of rollout priority:

### 2a. Polling (v1 — zero infra, ship first)

- A daemon/cron job on the user's box polls
  `GET /repos/:owner/:repo/pulls?...` on an interval, filtering for new
  dependabot/Renovate PRs.
- On a new PR: clone the branch, run packdev compat locally, hit the local
  model for the verdict, post the comment via the user's own `gh` token.
- Higher latency than a webhook, but requires nothing beyond the box already
  running the daemon. Good first self-hosted implementation.

### 2b. Webhook relay (v2 — deferred until there's demand)

- A shared relay (hosted by this project) receives GitHub webhooks for
  opted-in repos and forwards jobs to the user's box over an **outbound**
  connection the box itself opens — same pattern GitHub self-hosted Actions
  runners use, so no inbound port is required on the user's side.
- Lower latency than polling, but means operating and trusting a piece of
  shared relay infra. Worth building only once polling proves the demand.
- **Who it's for**: privacy-sensitive orgs, cost-sensitive users avoiding
  per-call API fees, air-gapped/regulated environments.

## Shared core

Both modes run the same underlying work — packdev compat testing inside a
sandbox, producing a structured verdict. The only things that vary are:

1. **Trigger + execution environment** — GitHub Action vs. a
   polling/webhook-driven process on the user's own infra.
2. **Model backend** — hosted LLM API vs. local model endpoint.

The orchestration layer in this repo should be trigger-agnostic and
model-agnostic so both modes share one implementation of the actual
compat-check-and-report logic.
