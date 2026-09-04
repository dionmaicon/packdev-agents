# Self-hosted mode

Runs on your own infra: no code, dependency manifests, or diffs leave your
network unless you point `PACKDEV_BRAIN`/`PACKDEV_MODEL_PROVIDER` at a hosted API yourself.
Forge-agnostic — GitHub and Gitea are both built in, and anything else
(GitLab, Bitbucket, a private forge) can be added without a PR to this repo
via `PACKDEV_PROVIDER_MODULE`.

## Quick start: 3 choices, then run

Every deployment makes the same three decisions. Everything else in this
doc is optional tuning.

1. **Which subcommand?** Run either, or both — they're independent and
   never conflict:
   - `compat` — deterministic pass/fail verdict, can auto-merge
   - `triage` — experimental LLM advisory comment, never merges
2. **Which forge, and how many repos?** Set `PACKDEV_PROVIDER` (or `PACKDEV_PROVIDER_MODULE`
   for anything not built in — see below), and `PACKDEV_REPO` for one repo or
   `PACKDEV_REPOS` for a comma-separated list, all watched with the same
   provider/token:
   - `github` (default) — needs `PACKDEV_PROVIDER_TOKEN`
   - `gitea` — needs `PACKDEV_PROVIDER_URL` + `PACKDEV_PROVIDER_TOKEN` + `PACKDEV_PROVIDER_USERNAME`
3. **How does it run?** `--once` from your own cron/systemd timer, the
   built-in poll loop, or `--webhook` if your box has a reachable endpoint
   (instant instead of polling — see "Webhook mode" below).

Minimal working example, GitHub, `compat` only, single run:

```sh
npm install -g @packdev/agents
PACKDEV_REPO=owner/repo PACKDEV_PROVIDER_TOKEN=ghp_... PACKDEV_TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Same, watching a whole list of repos (one bot account, several repos it
has access to — the common self-hosted shape, one process instead of one
per repo):

```sh
PACKDEV_REPOS=owner/repo-a,owner/repo-b,owner/repo-c PACKDEV_PROVIDER_TOKEN=ghp_... PACKDEV_TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Each repo in the list is polled and processed independently — one repo's
API hiccup or a renamed/deleted repo doesn't stop the rest of the list
from running that cycle (see the `PACKDEV_REPOS` row in the reference table below
for how clone dirs and state files stay isolated per repo).

Same, but against Gitea:

```sh
PACKDEV_REPO=owner/repo PACKDEV_PROVIDER=gitea \
  PACKDEV_PROVIDER_URL=https://gitea.example.com PACKDEV_PROVIDER_TOKEN=... PACKDEV_PROVIDER_USERNAME=... \
  PACKDEV_TEST_COMMAND="npm test" \
  packdev-agents compat --once
```

Add the advisory pass on top (needs a model — hosted Anthropic shown here,
`openai-compatible` also covers a local Ollama/vLLM endpoint):

```sh
PACKDEV_REPO=owner/repo PACKDEV_PROVIDER_TOKEN=ghp_... ANTHROPIC_API_KEY=sk-ant-... \
  packdev-agents triage --once
```

Everything past this point is reference detail for tuning one of those
three choices — required vs. optional env vars, the credential model, the
`PACKDEV_PROVIDER_MODULE` contract for a forge that isn't built in, and Docker.

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
  -e PACKDEV_REPO=owner/repo \
  -e PACKDEV_PROVIDER=github -e PACKDEV_PROVIDER_TOKEN=ghp_... \
  -e PACKDEV_TEST_COMMAND="npm test" \
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
(`PACKDEV_CLONE_DIR`, default `./.packdev-agents/repo`) and the seen-PR state
(`PACKDEV_STATE_PATH`/`PACKDEV_TRIAGE_STATE_PATH`) live. Without it, a `--rm` container
loses both on exit and every cron-triggered run reprocesses every open PR
from scratch instead of skipping ones already handled at the current head.

## Commands

```
packdev-agents compat [--once|--webhook]     # deterministic packdev-compat pipeline, can auto-merge
packdev-agents triage [--once|--webhook]     # experimental agentic advisory pipeline, never merges
```

Without `--once`/`--webhook`, either command polls in a loop
(`PACKDEV_POLL_INTERVAL_SECONDS`, default 300) until `SIGINT`/`SIGTERM`. `--once`
runs a single cycle and exits — the shape to use from your own cron/systemd
timer instead of this process's built-in loop. `--webhook` starts an HTTP
listener instead — see "Webhook mode" below.

## Webhook mode

Only worth using if your box already has a reachable endpoint — a VPS, a
home box with port forwarding, or (for local testing) a box exposed via
your own tunnel of choice. If not, the poll loop above is the simpler
default and needs no inbound connectivity at all.

```sh
PACKDEV_REPO=owner/repo PACKDEV_PROVIDER_TOKEN=ghp_... PACKDEV_PROVIDER_WEBHOOK_SECRET=... PACKDEV_TEST_COMMAND="npm test" \
  packdev-agents compat --webhook
```

| Var | Required | Notes |
|---|---|---|
| `PACKDEV_WEBHOOK_PORT` | no | default `8080` |
| `PACKDEV_WEBHOOK_PATH` | no | default `/webhook` |
| `PACKDEV_PROVIDER_WEBHOOK_SECRET` | required for every built-in provider | checked at startup, before the server binds — a missing secret fails immediately rather than accepting unverified requests |

`--webhook` and `--once` are mutually exclusive. A `PACKDEV_PROVIDER_MODULE` must
implement the optional `verifyWebhookSignature` method (see
`src/providers/types.ts`) to be usable with `--webhook`; a module that
doesn't implement it fails at startup with a clear error, rather than
silently accepting unverified requests.

The listener itself has no TLS support — it speaks plain HTTP. For
anything crossing a public network (including a tunnel to a local box),
register the webhook with an `https://` URL and terminate TLS in front of
the listener: a tunnel tool that itself provides HTTPS (ngrok, Cloudflare
Tunnel), or your own reverse proxy if the box is directly reachable.
Registering a bare `http://` URL sends both the PR payload and a replayable
signed delivery across the network in clear text — only acceptable on a
network you already trust end to end (e.g. a private LAN/VPN).

Register the webhook URL (`https://your-host$PACKDEV_WEBHOOK_PATH` — via a TLS
tunnel/proxy in front of `$PACKDEV_WEBHOOK_PORT`, see above) on your forge:

- **GitHub**: repo Settings → Webhooks → Add webhook. Payload URL as
  above, content type `application/json`, secret = your
  `PACKDEV_PROVIDER_WEBHOOK_SECRET`, events: "Pull requests" only.
- **Gitea**: repo Settings → Webhooks → Add Webhook → Gitea. Target URL as
  above, content type `application/json`, secret = your
  `PACKDEV_PROVIDER_WEBHOOK_SECRET`, trigger on "Pull Request" events only.

Every repo in a `PACKDEV_REPOS` list is served from the same listener (matched by
the webhook payload's `repository.full_name`) — no per-repo port/process
needed. Concurrent triggers for the same repo are coalesced: a second
trigger arriving while a run is already in flight queues at most one
follow-up run instead of racing on the same clone dir/state file.

### Local testing with a tunnel

Simplest option: run the tunnel tool's own official image as a second
compose service — most tunnel tools (ngrok, Cloudflare Tunnel, ...) publish
one, and it already has the binary, so no build step is needed. It also
runs as a **separate** container from the webhook listener (one process
per container; the tunnel dying shouldn't take down the listener, or vice
versa):

```yaml
# docker-compose.yml — two services, one network
services:
  packdev-agents:
    image: packdev-agents:local
    command: ["compat", "--webhook"]
    environment:
      PACKDEV_REPO: owner/repo
      PACKDEV_PROVIDER_TOKEN: ghp_...
      PACKDEV_PROVIDER_WEBHOOK_SECRET: s3cret
      PACKDEV_TEST_COMMAND: "npm test"
      PACKDEV_WEBHOOK_PORT: "8080"

  tunnel:
    image: ngrok/ngrok:latest
    command: ["http", "packdev-agents:8080"]
    environment:
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
```

(Swap the `tunnel` service for any other tool's own image the same way —
`cloudflare/cloudflared`, etc.)

If you'd rather build one custom image that bundles both this CLI and a
tunnel binary, `scripts/tunnel.sh` is for that case: a deliberately generic
launcher in this image — it never hardcodes a specific tool — that execs
whatever you set `TUNNEL_COMMAND` to. Build a small derived image that adds
the binary on top of this one, then point `entrypoint` at the script
instead of a separate tool image:

```dockerfile
# Dockerfile.tunnel — adds ngrok to this image, kept as a separate service.
# Copies the binary out of ngrok's own official, signed image instead of
# piping an arbitrary URL through curl into tar as root — a compromised or
# MITM'd download at build time would otherwise run as root with no
# checksum/signature check at all.
FROM ngrok/ngrok:latest AS ngrok
FROM packdev-agents:local
USER root
COPY --from=ngrok /bin/ngrok /usr/local/bin/ngrok
USER packdev
ENTRYPOINT ["./scripts/tunnel.sh"]
```

```yaml
  tunnel:
    build:
      context: .
      dockerfile: Dockerfile.tunnel
    environment:
      TUNNEL_COMMAND: "ngrok http packdev-agents:8080 --authtoken=$NGROK_AUTHTOKEN"
      NGROK_AUTHTOKEN: ${NGROK_AUTHTOKEN}
```

No tunnel binary is bundled in the published `packdev-agents` image itself
either way — keeps it lean and provider-agnostic; you choose one of the two
shapes above based on whether you want a separate image or one derived
image.

## Environment variables

Both subcommands:

| Var | Required | Notes |
|---|---|---|
| `PACKDEV_REPO` | yes, unless `PACKDEV_REPOS` is set | `owner/repo` — one repo |
| `PACKDEV_REPOS` | yes, unless `PACKDEV_REPO` is set | comma-separated `owner/repo,owner/other` — a list, same `PACKDEV_PROVIDER`/token for every entry; mutually exclusive with `PACKDEV_REPO`. Each repo is polled and processed independently: one repo's API failure or a renamed/deleted repo doesn't stop the rest of the list that cycle. |
| `PACKDEV_PROVIDER` | no | `github` (default) or `gitea` |
| `PACKDEV_PROVIDER_MODULE` | no | path or package specifier for a custom provider — see below. Overrides `PACKDEV_PROVIDER` when set. |
| `PACKDEV_PROVIDER_TOKEN` | required for every built-in provider | GitHub: needs `repo` scope (comment, check-run, merge). Gitea: needs `read:repository`, `write:repository`, `read:issue`, `write:issue` scopes |
| `PACKDEV_PROVIDER_URL`, `PACKDEV_PROVIDER_USERNAME` | additionally required if `PACKDEV_PROVIDER=gitea` | `PACKDEV_PROVIDER_USERNAME` must be the token owner's username — Gitea's git-http-backend needs a real username alongside the token as password, a bare token with no username is rejected for private repos |
| `PACKDEV_REMOTE_URL` | no | overrides the git clone URL the provider derives by default. **Single-`PACKDEV_REPO` only** — rejected outright when `PACKDEV_REPOS` has more than one entry, since one override URL can't correctly apply to every repo in a list. Credentials are never embedded in this URL either way — see "Credentials" below. |
| `PACKDEV_ALLOWED_ACTORS` | no | comma-separated PR author allowlist, default `dependabot[bot],renovate[bot]` (`PACKDEV_PROVIDER=gitea` also allows bare `renovate` by default — Gitea's actor field has no `[bot]` suffix convention, so a Renovate PR shows up as actor `renovate`) — applies to every repo in a `PACKDEV_REPOS` list |
| `PACKDEV_PACKAGE_JSON_PATH` | no | pin to one `package.json` in a monorepo instead of auto-discovering — applies to every repo in a `PACKDEV_REPOS` list |
| `PACKDEV_CLONE_DIR` | no | single `PACKDEV_REPO`: the clone dir itself, default `./.packdev-agents/repo`. `PACKDEV_REPOS` list: the ROOT dir, one namespaced subdir per repo underneath, default root `./.packdev-agents/repos` |
| `PACKDEV_POLL_INTERVAL_SECONDS` | no | default `300`, must be a positive number (loop mode only) |

`compat`-only:

| Var | Required | Notes |
|---|---|---|
| `PACKDEV_TEST_COMMAND` \| `PACKDEV_TEST_SCRIPT` | yes, exactly one | prefer `PACKDEV_TEST_SCRIPT` — see the pipeline's own doc comment for why. Applies to every repo in a `PACKDEV_REPOS` list — all repos in one list must share the same test invocation shape. |
| `PACKDEV_STATE_PATH` | no | single `PACKDEV_REPO`: the state file itself, default `./.packdev-agents/state.json`. `PACKDEV_REPOS` list: the ROOT dir, one file per repo underneath, default root `./.packdev-agents/state` |
| `PACKDEV_AUTO_MERGE` | no | `"true"` to merge automatically on a `PASSED` verdict, default off |
| `PACKDEV_TEST_COMBINED_BUMP` | no | see architecture.md — default on |
| `PACKDEV_BRAIN` | no | `anthropic` \| `openai-compatible`, optional failure-summary prose |

`triage`-only (experimental, advisory-only, never merges):

| Var | Required | Notes |
|---|---|---|
| `PACKDEV_TRIAGE_STATE_PATH` | no | same single-`PACKDEV_REPO`-vs-`PACKDEV_REPOS`-list shape as `PACKDEV_STATE_PATH` above — independent from `compat`'s own state either way. Default `./.packdev-agents/triage-state.json` or root `./.packdev-agents/triage-state` |
| `PACKDEV_MAX_TURNS` | no | agent tool-use loop cap |
| `PACKDEV_MODEL_PROVIDER` | no | `anthropic` (default) \| `openai-compatible` |

A `PACKDEV_REPO`/`PACKDEV_REPOS` list can't mix providers or tokens — every repo in one
process is watched with the same `PACKDEV_PROVIDER`/credentials. Watching a GitHub
repo and a Gitea repo together, or using per-repo tokens, needs two
separate `packdev-agents` processes/containers (or a `PACKDEV_PROVIDER_MODULE`
that internally fans out, if you want one process for that case).

Model credentials (`ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` or
`OPENAI_COMPATIBLE_BASE_URL`/`OPENAI_COMPATIBLE_MODEL`/`OPENAI_COMPATIBLE_API_KEY`)
are shared by `PACKDEV_BRAIN` and `PACKDEV_MODEL_PROVIDER` — the `openai-compatible` backend
also covers a local Ollama/vLLM endpoint, keeping data on your network.

## Credentials

Whatever token the provider needs (`PACKDEV_PROVIDER_TOKEN`) is used for
BOTH the forge's REST API and git itself — it is never baked into
`PACKDEV_REMOTE_URL` or persisted into `.git/config`. Instead it's applied as an
`Authorization` header on each individual `git clone`/`git fetch` via
`GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_0`/`GIT_CONFIG_VALUE_0` environment
variables (not `-c` on the command line, which would expose the token to
any local process listing for as long as the git child runs), so the
clone directory never holds a long-lived plaintext credential on disk and
the token never appears in `ps` output either.

## Writing a custom provider (`PACKDEV_PROVIDER_MODULE`)

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

Point `PACKDEV_PROVIDER_MODULE` at it:

```sh
PACKDEV_PROVIDER_MODULE=./my-provider.mjs packdev-agents compat --once
```

A **relative path** (`./...`, `../...`) or an absolute path resolves
against the directory you ran `packdev-agents` from (`process.cwd()`), not
against this package's own install location — so the same relative path
works the same way whether you installed via npm, ran from a clone, or ran
inside Docker with the module bind-mounted in. A **bare specifier**
(`@my-org/my-provider`) resolves the normal Node way, from `node_modules`.

See `src/providers/github/index.ts` and `src/providers/gitea/index.ts` for
two complete, real implementations of this exact contract.
