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

Working, real-tested end to end — see `docs/architecture.md` for the full
design and `docs/use-cases.md` for the two deployment modes. Live-verified
against real Dependabot PRs on two demo repos
([packdev-demo-express](https://github.com/dionmaicon/packdev-demo-express),
[packdev-demo-nestjs](https://github.com/dionmaicon/packdev-demo-nestjs)).

## Required setup: branch protection

**A failing `compat` check run does NOT block merging by itself.** GitHub
only disables the "Merge pull request" button when the target branch has
**branch protection** (or a repository ruleset) configured with `compat`
as a required status check — without it, a red X is purely informational
and the button stays clickable. This action deliberately does not
configure this for you (it's a repo-owner, security-sensitive setting,
and doing it from within a workflow run would itself be an odd pattern).

To set it up:

```sh
gh api --method PUT repos/<owner>/<repo>/branches/<branch>/protection --input - <<'EOF'
{
  "required_status_checks": { "strict": false, "contexts": ["compat"] },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null
}
EOF
```

(Or Settings → Branches → Add rule → Require status checks to pass →
select `compat`.) Note: on GitHub's free plan, branch protection for a
**private** repository requires GitHub Pro — it works for free on public
repos. Don't require the `agentic-triage` check the same way — it's
advisory-only by design (see `docs/architecture.md`) and isn't meant to
gate a merge.

## Modes

- **GitHub mode** — ships as a reusable GitHub Action. Zero infra for the
  user beyond a workflow file and an LLM API key.
- **Self-hosted mode** — runs on the user's own infra (local model, no data
  leaves their network), against GitHub, Gitea, or a custom forge via a
  small plugin — no GitHub dependency at runtime. Ships as the
  `@tchebit/packdev-agents` npm package (`packdev-agents compat|triage`) or a
  Docker image. See `docs/self-hosted.md`.

See `docs/use-cases.md` for details.

## Relationship to packdev

Results and links from this repo get referenced back from `packdev`'s docs
once a use case is working and tested — this repo does not get folded back
into `packdev`.
