# Self-hosted mode

Runs on your own infra: no code, dependency manifests, or diffs leave your
network unless you point `BRAIN`/`MODEL_PROVIDER` at a hosted API yourself.
Forge-agnostic — GitHub and Gitea are both built in, and anything else
(GitLab, Bitbucket, a private forge) can be added without a PR to this repo
via `PROVIDER_MODULE`.

## Quick start: 3 choices, then run

Every deployment makes the same three decisions. Everything else in this
doc is optional tuning.

1. **Which subcommand?** Run either, or both — they're independent and
   never conflict:
   - `compat` — deterministic pass/fail verdict, can auto-merge
   - `triage` — experimental LLM advisory comment, never merges
2. **Which forge, and how many repos?** Set `PROVIDER` (or `PROVIDER_MODULE`
   for anything not built in — see below), and `REPO` for one repo or
   `REPOS` for a comma-separated list, all watched with the same
   provider/token:
   - `github` (default) — needs `GITHUB_TOKEN`
   - `gitea` — needs `GITEA_URL` + `GITEA_TOKEN` + `GITEA_USERNAME`
3. **How does it run?** `--once` from your own cron/systemd timer, the
   built-in poll loop, or the Docker image — see "Install" below.

Minimal working example, GitHub, `compat` only, single run:

```sh
npm install -g @packdev/agents
REPO=owner/repo GITHUB_TOKEN=ghp_... TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Same, watching a whole list of repos (one bot account, several repos it
has access to — the common self-hosted shape, one process instead of one
per repo):

```sh
REPOS=owner/repo-a,owner/repo-b,owner/repo-c GITHUB_TOKEN=ghp_... TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Each repo in the list is polled and processed independently — one repo's
API hiccup or a renamed/deleted repo doesn't stop the rest of the list
from running that cycle (see the `REPOS` row in the reference table below
for how clone dirs and state files stay isolated per repo).

Same, but against Gitea:

```sh
REPO=owner/repo PROVIDER=gitea \
  GITEA_URL=https://gitea.example.com GITEA_TOKEN=... GITEA_USERNAME=... \
  TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Add the advisory pass on top (needs a model — hosted Anthropic shown here,
`openai-compatible` also covers a local Ollama/vLLM endpoint):

```sh
REPO=owner/repo GITHUB_TOKEN=ghp_... ANTHROPIC_API_KEY=sk-ant-... \
  packdev-agents triage --once
```

Everything past this point is reference detail for tuning one of those
three choices — required vs. optional env vars, the credential model, the
`PROVIDER_MODULE` contract for a forge that isn't built in, and Docker.

## Install

**npm:**

```sh
npm install -g @packdev/agents
packdev-agents compat --once
```

**Docker:**

```sh
docker build -t packdev-agents .
docker run --rm \
  -v packdev-agents-data:/app/.packdev-agents \
  -e REPO=owner/repo \
  -e PROVIDER=github -e GITHUB_TOKEN=ghp_... \
  -e TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Use a **named volume** (`packdev-agents-data`), not a bind mount to a host
directory. The image runs as a non-root `packdev` user; a bind mount of a
host directory brings the host directory's UID with it, which usually
doesn't match the container's `packdev` UID, so the clone/state writes fail
with a permission error. A named volume's contents are initialized from
the image (correct ownership already in place) the first time it's used —
no UID matching needed. If you specifically need the data on the host
filesystem, either bind-mount `/app/.packdev-agents` from a host directory
already `chown`'d to the container's `packdev` UID (find it with
`docker run --rm packdev-agents id -u packdev`), or run the container with
`--user "$(id -u):$(id -g)"` to match your own UID instead.

The volume is required even with `--once`: it's where the clone
(`CLONE_DIR`, default `./.packdev-agents/repo`) and the seen-PR state
(`STATE_PATH`/`TRIAGE_STATE_PATH`) live. Without it, a `--rm` container
loses both on exit and every cron-triggered run reprocesses every open PR
from scratch instead of skipping ones already handled at the current head.

## Commands

```
packdev-agents compat [--once]     # deterministic packdev-compat pipeline, can auto-merge
packdev-agents triage [--once]     # experimental agentic advisory pipeline, never merges
```

Without `--once`, either command polls in a loop (`POLL_INTERVAL_SECONDS`,
default 300) until `SIGINT`/`SIGTERM`. `--once` runs a single cycle and
exits — the shape to use from your own cron/systemd timer instead of this
process's built-in loop.

## Environment variables

Both subcommands:

| Var | Required | Notes |
|---|---|---|
| `REPO` | yes, unless `REPOS` is set | `owner/repo` — one repo |
| `REPOS` | yes, unless `REPO` is set | comma-separated `owner/repo,owner/other` — a list, same `PROVIDER`/token for every entry; mutually exclusive with `REPO`. Each repo is polled and processed independently: one repo's API failure or a renamed/deleted repo doesn't stop the rest of the list that cycle. |
| `PROVIDER` | no | `github` (default) or `gitea` |
| `PROVIDER_MODULE` | no | path or package specifier for a custom provider — see below. Overrides `PROVIDER` when set. |
| `GITHUB_TOKEN` | if `PROVIDER=github` | needs `repo` scope (comment, check-run, merge) |
| `GITEA_URL`, `GITEA_TOKEN`, `GITEA_USERNAME` | if `PROVIDER=gitea` | token needs `read:repository`, `write:repository`, `read:issue`, `write:issue` scopes; `GITEA_USERNAME` must be the token owner's username — Gitea's git-http-backend needs a real username alongside the token as password, a bare token with no username is rejected for private repos |
| `REMOTE_URL` | no | overrides the git clone URL the provider derives by default. **Single-`REPO` only** — rejected outright when `REPOS` has more than one entry, since one override URL can't correctly apply to every repo in a list. Credentials are never embedded in this URL either way — see "Credentials" below. |
| `ALLOWED_ACTORS` | no | comma-separated PR author allowlist, default `dependabot[bot],renovate[bot]` (`PROVIDER=gitea` also allows bare `renovate` by default — Gitea's actor field has no `[bot]` suffix convention, so a Renovate PR shows up as actor `renovate`) — applies to every repo in a `REPOS` list |
| `PACKAGE_JSON_PATH` | no | pin to one `package.json` in a monorepo instead of auto-discovering — applies to every repo in a `REPOS` list |
| `CLONE_DIR` | no | single `REPO`: the clone dir itself, default `./.packdev-agents/repo`. `REPOS` list: the ROOT dir, one namespaced subdir per repo underneath, default root `./.packdev-agents/repos` |
| `POLL_INTERVAL_SECONDS` | no | default `300`, must be a positive number (loop mode only) |

`compat`-only:

| Var | Required | Notes |
|---|---|---|
| `TEST_COMMAND` \| `TEST_SCRIPT` | yes, exactly one | prefer `TEST_SCRIPT` — see the pipeline's own doc comment for why. Applies to every repo in a `REPOS` list — all repos in one list must share the same test invocation shape. |
| `STATE_PATH` | no | single `REPO`: the state file itself, default `./.packdev-agents/state.json`. `REPOS` list: the ROOT dir, one file per repo underneath, default root `./.packdev-agents/state` |
| `AUTO_MERGE` | no | `"true"` to merge automatically on a `PASSED` verdict, default off |
| `TEST_COMBINED_BUMP` | no | see architecture.md — default on |
| `BRAIN` | no | `anthropic` \| `openai-compatible`, optional failure-summary prose |

`triage`-only (experimental, advisory-only, never merges):

| Var | Required | Notes |
|---|---|---|
| `TRIAGE_STATE_PATH` | no | same single-`REPO`-vs-`REPOS`-list shape as `STATE_PATH` above — independent from `compat`'s own state either way. Default `./.packdev-agents/triage-state.json` or root `./.packdev-agents/triage-state` |
| `MAX_TURNS` | no | agent tool-use loop cap |
| `MODEL_PROVIDER` | no | `anthropic` (default) \| `openai-compatible` |

A `REPO`/`REPOS` list can't mix providers or tokens — every repo in one
process is watched with the same `PROVIDER`/credentials. Watching a GitHub
repo and a Gitea repo together, or using per-repo tokens, needs two
separate `packdev-agents` processes/containers (or a `PROVIDER_MODULE`
that internally fans out, if you want one process for that case).

Model credentials (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or
`OPENAI_COMPATIBLE_BASE_URL`/`OPENAI_COMPATIBLE_MODEL`/`OPENAI_COMPATIBLE_API_KEY`)
are shared by `BRAIN` and `MODEL_PROVIDER` — the `openai-compatible` backend
also covers a local Ollama/vLLM endpoint, keeping data on your network.

## Credentials

Whatever token the provider needs (`GITHUB_TOKEN`/`GITEA_TOKEN`) is used for
BOTH the forge's REST API and git itself — it is never baked into
`REMOTE_URL` or persisted into `.git/config`. Instead it's applied as an
`Authorization` header on each individual `git clone`/`git fetch` via
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment
variables (not `-c` on the command line, which would expose the token to
any local process listing for as long as the git child runs), so the
clone directory never holds a long-lived plaintext credential on disk and
the token never appears in `ps` output either.

## Writing a custom provider (`PROVIDER_MODULE`)

A provider is a small factory implementing this contract (from
`@packdev/agents`'s exported types — `src/providers/types.ts`):

```ts
import type { ProviderFactory } from "@packdev/agents";

const createProvider: ProviderFactory = (env) => {
  // read whatever env vars your forge needs, e.g. env.MY_FORGE_TOKEN
  return {
    createPullRequestSource: () => ({
      async listOpenBotPRs() {
        // return every OPEN pull request from bot/dependency-bump authors:
        // [{ number, actor, baseBranch, baseSha, headBranch, headSha }, ...]
      },
    }),
    createForgeOpsFor: (pr) => ({
      async upsertComment({ marker, body }) { /* create or update your marker comment */ },
      async createCheckRun({ name, conclusion, title, summary }) { /* best-effort; no-op is fine if your forge has no check-run concept */ },
      async mergePullRequest() { /* merge pr.number */ },
    }),
    createGitRemote: () => ({
      url: `https://my-forge.example.com/${env.MY_FORGE_OWNER}/${env.MY_FORGE_REPO}.git`,
      // Optional. Applied per git invocation via GIT_CONFIG_* env vars,
      // never on the command line — never embed a credential directly in
      // `url` (see "Credentials" above).
      // Check your forge's docs for which Basic-auth slot the token goes
      // in — GitHub wants it as the password with a fixed `x-access-token`
      // username, Gitea wants a real username plus the token as password;
      // a bare token with no username is rejected by both for private repos.
      authHeader: `Authorization: Basic ${Buffer.from(`${env.MY_FORGE_USERNAME}:${env.MY_FORGE_TOKEN}`).toString("base64")}`,
    }),
  };
};

export default createProvider;
```

Point `PROVIDER_MODULE` at it:

```sh
PROVIDER_MODULE=./my-provider.mjs packdev-agents compat --once
```

A **relative path** (`./...`, `../...`) or an absolute path resolves
against the directory you ran `packdev-agents` from (`process.cwd()`), not
against this package's own install location — so the same relative path
works the same way whether you installed via npm, ran from a clone, or ran
inside Docker with the module bind-mounted in. A **bare specifier**
(`@my-org/my-provider`) resolves the normal Node way, from `node_modules`.

See `src/providers/github/index.ts` and `src/providers/gitea/index.ts` for
two complete, real implementations of this exact contract.
