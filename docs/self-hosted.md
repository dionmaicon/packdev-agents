# Self-hosted mode

Runs on your own infra: no code, dependency manifests, or diffs leave your
network unless you point `BRAIN`/`MODEL_PROVIDER` at a hosted API yourself.
Forge-agnostic — GitHub and Gitea are both built in, and anything else
(GitLab, Bitbucket, a private forge) can be added without a PR to this repo
via `PROVIDER_MODULE`.

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
  -e REPO=owner/repo \
  -e PROVIDER=github -e GITHUB_TOKEN=ghp_... \
  -e TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

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
| `REPO` | yes | `owner/repo` |
| `PROVIDER` | no | `github` (default) or `gitea` |
| `PROVIDER_MODULE` | no | path or package specifier for a custom provider — see below. Overrides `PROVIDER` when set. |
| `GITHUB_TOKEN` | if `PROVIDER=github` | needs `repo` scope (comment, check-run, merge) |
| `GITEA_URL`, `GITEA_TOKEN` | if `PROVIDER=gitea` | token needs `read:repository`, `write:repository`, `read:issue`, `write:issue` scopes |
| `REMOTE_URL` | no | overrides the git clone URL the provider derives by default. Credentials are never embedded in this URL either way — see "Credentials" below. |
| `ALLOWED_ACTORS` | no | comma-separated PR author allowlist, default `dependabot[bot],renovate[bot]` |
| `PACKAGE_JSON_PATH` | no | pin to one `package.json` in a monorepo instead of auto-discovering |
| `CLONE_DIR` | no | default `./.packdev-agents/repo` |
| `POLL_INTERVAL_SECONDS` | no | default `300`, must be a positive number (loop mode only) |

`compat`-only:

| Var | Required | Notes |
|---|---|---|
| `TEST_COMMAND` \| `TEST_SCRIPT` | yes, exactly one | prefer `TEST_SCRIPT` — see the pipeline's own doc comment for why |
| `STATE_PATH` | no | default `./.packdev-agents/state.json` |
| `AUTO_MERGE` | no | `"true"` to merge automatically on a `PASSED` verdict, default off |
| `TEST_COMBINED_BUMP` | no | see architecture.md — default on |
| `BRAIN` | no | `anthropic` \| `openai-compatible`, optional failure-summary prose |

`triage`-only (experimental, advisory-only, never merges):

| Var | Required | Notes |
|---|---|---|
| `TRIAGE_STATE_PATH` | no | default `./.packdev-agents/triage-state.json` — independent from `compat`'s own state |
| `MAX_TURNS` | no | agent tool-use loop cap |
| `MODEL_PROVIDER` | no | `anthropic` (default) \| `openai-compatible` |

Model credentials (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or
`OPENAI_COMPATIBLE_BASE_URL`/`OPENAI_COMPATIBLE_MODEL`/`OPENAI_COMPATIBLE_API_KEY`)
are shared by `BRAIN` and `MODEL_PROVIDER` — the `openai-compatible` backend
also covers a local Ollama/vLLM endpoint, keeping data on your network.

## Credentials

Whatever token the provider needs (`GITHUB_TOKEN`/`GITEA_TOKEN`) is used for
BOTH the forge's REST API and git itself — it is never baked into
`REMOTE_URL` or persisted into `.git/config`. Instead it's applied as an
`Authorization` header on each individual `git clone`/`git fetch`
(`-c http.extraHeader=...`), so the clone directory never holds a
long-lived plaintext credential on disk.

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
      // Optional. Applied per git invocation via -c http.extraHeader — never
      // embed a credential directly in `url` (see "Credentials" above).
      authHeader: `Authorization: Basic ${Buffer.from(`${env.MY_FORGE_TOKEN}:`).toString("base64")}`,
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
