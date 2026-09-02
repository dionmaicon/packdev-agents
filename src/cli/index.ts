#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createAnthropicBrain, createOpenAiCompatibleBrain, type Brain } from "../core/brain.js";
import type { CompatStepResult } from "../core/pipeline.js";
import { resolveProvider } from "../providers/registry.js";
import type { Provider } from "../providers/types.js";
import { pollOnce, type PollResult } from "../adapters/selfhosted/poll.js";
import { pollTriageOnce, type TriagePollResult } from "../adapters/agentic-triage/poll.js";
import { createAnthropicAgentLoop, createOpenAiCompatibleAgentLoop, type AgentLoop } from "../adapters/agentic-triage/agentLoop.js";
import { createPollLoop } from "../adapters/selfhosted/loop.js";

function env(name: string): string | undefined {
  return process.env[name];
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared by compat's own log lines below — avoids the "add a step kind, forget a call site" trap that fixing this file's own compile errors just caught once already. */
function stepKindLabel(step: CompatStepResult): string {
  switch (step.kind) {
    case "static-incompatible":
      return "STATIC_INCOMPATIBLE";
    case "verdict":
      return step.verdict.kind;
  }
}

function buildBrain(): Brain | undefined {
  const kind = env("BRAIN") ?? "none";

  switch (kind) {
    case "none":
      return undefined;
    case "anthropic":
      return createAnthropicBrain({
        apiKey: requireEnv("ANTHROPIC_API_KEY"),
        ...(env("ANTHROPIC_MODEL") ? { model: env("ANTHROPIC_MODEL")! } : {}),
      });
    case "openai-compatible":
      return createOpenAiCompatibleBrain({
        baseUrl: requireEnv("OPENAI_COMPATIBLE_BASE_URL"),
        model: requireEnv("OPENAI_COMPATIBLE_MODEL"),
        ...(env("OPENAI_COMPATIBLE_API_KEY") ? { apiKey: env("OPENAI_COMPATIBLE_API_KEY")! } : {}),
      });
    default:
      throw new Error(`Unknown BRAIN "${kind}" — expected "none", "anthropic", or "openai-compatible"`);
  }
}

/** Mirrors buildBrain()'s shape — same "one interface, pick a backend by env" pattern, distinct env var (MODEL_PROVIDER) since triage's model choice is independent of compat's optional failure-summary brain. */
function buildAgentLoop(): AgentLoop {
  const provider = env("MODEL_PROVIDER") ?? "anthropic";

  switch (provider) {
    case "anthropic":
      return createAnthropicAgentLoop({
        apiKey: requireEnv("ANTHROPIC_API_KEY"),
        ...(env("ANTHROPIC_MODEL") ? { model: env("ANTHROPIC_MODEL")! } : {}),
      });
    case "openai-compatible":
      return createOpenAiCompatibleAgentLoop({
        baseUrl: requireEnv("OPENAI_COMPATIBLE_BASE_URL"),
        model: requireEnv("OPENAI_COMPATIBLE_MODEL"),
        ...(env("OPENAI_COMPATIBLE_API_KEY") ? { apiKey: env("OPENAI_COMPATIBLE_API_KEY")! } : {}),
      });
    default:
      throw new Error(`Unknown MODEL_PROVIDER "${provider}" — expected "anthropic" or "openai-compatible"`);
  }
}

/** Shared by both subcommands — no test-execution config here, see readTestConfig(), which only `compat` actually needs. CLONE_DIR/STATE_PATH are resolved per repo, see resolveRepoPaths(). */
function readCommonEnv() {
  const allowedActorsInput = env("ALLOWED_ACTORS");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  return {
    allowedActors,
    packageJsonPath: env("PACKAGE_JSON_PATH"),
  };
}

/**
 * REPO ("owner/repo") is the single-repo form; REPOS ("owner/a,owner/b")
 * watches a whole list with the same PROVIDER/token — the common case for
 * a bot account with access to several repos in one org. Mutually
 * exclusive with REPO so there's exactly one way to say "one repo".
 */
export function readRepoList(): string[] {
  const repoSingle = env("REPO");
  const reposList = env("REPOS");
  if (repoSingle && reposList) {
    throw new Error("REPO and REPOS are mutually exclusive, got both.");
  }
  if (reposList !== undefined) {
    const repos = reposList.split(",").map((s) => s.trim()).filter(Boolean);
    if (repos.length === 0) {
      throw new Error(`REPOS must contain at least one "owner/repo", got "${reposList}".`);
    }
    return repos;
  }
  if (repoSingle) return [repoSingle];
  throw new Error("Missing required environment variable: REPO (or REPOS for a comma-separated list)");
}

/** Turns "owner/repo" into a filesystem-safe path segment. */
export function repoPathSegment(repo: string): string {
  return repo.replace(/[^a-zA-Z0-9._-]/g, "_");
}

interface RepoPaths {
  cloneDir: string;
  statePath: string;
}

/**
 * A single repo (REPO, or REPOS with exactly one entry) keeps today's flat
 * default paths for backward compatibility — upgrading an existing
 * single-repo deployment to this version must not silently relocate its
 * state file and make every already-tracked PR look new again.
 *
 * A REPOS list namespaces CLONE_DIR/STATE_PATH into a root dir with one
 * subdir/file per repo — sharing a clone dir or state file across repos
 * would be a real correctness bug, not just clutter: repoSync would clone
 * the wrong remote into an already-populated directory, and state.ts keys
 * seen-state by PR NUMBER ALONE (see its own doc comment), so repo A's PR
 * #1 and repo B's unrelated PR #1 would corrupt each other's skip logic.
 */
export function resolveRepoPaths(
  repos: string[],
  cloneDirEnv: string | undefined,
  statePathEnv: string | undefined,
  singleDefaults: RepoPaths,
  multiDefaults: RepoPaths,
): Map<string, RepoPaths> {
  const result = new Map<string, RepoPaths>();
  if (repos.length === 1) {
    const repo = repos[0]!;
    result.set(repo, {
      cloneDir: cloneDirEnv ?? singleDefaults.cloneDir,
      statePath: statePathEnv ?? singleDefaults.statePath,
    });
    return result;
  }
  const cloneRoot = cloneDirEnv ?? multiDefaults.cloneDir;
  const stateRoot = statePathEnv ?? multiDefaults.statePath;
  for (const repo of repos) {
    const segment = repoPathSegment(repo);
    result.set(repo, {
      cloneDir: path.join(cloneRoot, segment),
      statePath: path.join(stateRoot, `${segment}.json`),
    });
  }
  return result;
}

/**
 * `triage` never runs the app's own test command — runAgenticTriage lets
 * the model decide what to run via packdev's own tools — so pulling this
 * validation out of readCommonEnv() means a triage-only deployment doesn't
 * need a meaningless dummy TEST_COMMAND just to pass a check it never uses.
 */
function readTestConfig(): { testCommand: string | undefined; testScript: string | undefined } {
  const testCommand = env("TEST_COMMAND");
  const testScript = env("TEST_SCRIPT");
  if (!testCommand && !testScript) {
    throw new Error("Exactly one of TEST_COMMAND/TEST_SCRIPT env vars is required, got neither.");
  }
  if (testCommand && testScript) {
    throw new Error("TEST_COMMAND and TEST_SCRIPT are mutually exclusive, got both.");
  }
  return { testCommand, testScript };
}

/**
 * REMOTE_URL is an optional override — by default the git remote (and its
 * credential) comes straight from the resolved provider, which is also how
 * the credential-safe-by-default behavior in CR8 is achieved: the provider
 * always returns a clean URL + a per-request authHeader (see
 * providers/types.ts's GitRemote), never a token baked into the URL
 * itself. The authHeader is only forwarded when REMOTE_URL is unset or
 * points at the same origin as the provider's own URL — otherwise a
 * REMOTE_URL pointed at a different host would leak the forge token to
 * that host on every clone/fetch.
 */
export function resolveGitRemote(provider: { createGitRemote(): { url: string; authHeader?: string | undefined } } ): { remoteUrl: string; authHeader: string | undefined } {
  const remote = provider.createGitRemote();
  const override = env("REMOTE_URL");
  if (!override) {
    return { remoteUrl: remote.url, authHeader: remote.authHeader };
  }
  const sameOrigin = sameHttpOrigin(override, remote.url);
  return { remoteUrl: override, authHeader: sameOrigin ? remote.authHeader : undefined };
}

export function sameHttpOrigin(a: string, b: string): boolean {
  try {
    const urlA = new URL(a);
    const urlB = new URL(b);
    return urlA.protocol === urlB.protocol && urlA.host === urlB.host;
  } catch {
    return false;
  }
}

/**
 * Resolves (and thereby validates — REPO shape, required token/URL env
 * vars) every repo's provider up front, before any TEST_COMMAND check or
 * actual poll work runs. A bad REPO/token is a shared-config problem, not
 * a per-repo runtime hiccup, so it fails the whole run fast instead of
 * silently limping through some repos with broken credentials — per-repo
 * isolation (below) is for RUNTIME failures during the actual poll
 * (a renamed repo, a forge outage), not startup config errors.
 */
async function resolveProvidersForRepos(repos: string[]): Promise<Map<string, Provider>> {
  const providers = new Map<string, Provider>();
  for (const repo of repos) {
    providers.set(repo, await resolveProvider({ ...process.env, REPO: repo }));
  }
  return providers;
}

interface RepoRunOutcome<T extends { failed: unknown[] }> {
  repo: string;
  ok: boolean;
  result?: T;
  error?: unknown;
}

function logCompatResult(repo: string, result: PollResult): void {
  for (const { pr, result: prResult } of result.processed) {
    if (prResult.status === "verdict") {
      console.log(`[${repo}] PR #${pr.number}: ${prResult.verdict.kind} (merged: ${prResult.merged})`);
    } else if (prResult.status === "unsupported-bump") {
      console.log(`[${repo}] PR #${pr.number}: unsupported bump — ${prResult.bump.reason}`);
    } else if (prResult.status === "static-incompatible") {
      console.log(
        `[${repo}] PR #${pr.number}: static incompatible — ${prResult.bump.name} ` +
          `${prResult.bump.fromVersion} → ${prResult.bump.toVersion} (packdev api-diff, skipped compat)`,
      );
    } else if (prResult.status === "cross-file-verdict") {
      const kinds = prResult.results.map((r) => stepKindLabel(r.step)).join(", ");
      console.log(
        `[${repo}] PR #${pr.number}: cross-file — ${prResult.bump.name} ${prResult.bump.toVersion} across ` +
          `${prResult.results.length} apps [${kinds}] (merged: ${prResult.merged})`,
      );
    } else if (prResult.status === "independent-verdict") {
      const kinds = prResult.results.map((r) => stepKindLabel(r.step)).join(", ");
      console.log(
        `[${repo}] PR #${pr.number}: independent bumps — ${prResult.results.length} packages [${kinds}], ` +
          `combined: ${prResult.combined.kind} (merged: ${prResult.merged})`,
      );
    }
  }
  if (result.skippedAlreadySeen.length > 0) {
    console.log(
      `[${repo}] Skipped (already processed at current head): ${result.skippedAlreadySeen.map((pr) => `#${pr.number}`).join(", ")}`,
    );
  }
  for (const { pr, error } of result.failed) {
    console.error(`[${repo}] PR #${pr.number}: FAILED this cycle, will retry next cycle — ${String(error)}`);
  }
}

async function runCompatOnce(): Promise<RepoRunOutcome<PollResult>[]> {
  const repos = readRepoList();
  if (repos.length > 1 && env("REMOTE_URL")) {
    throw new Error("REMOTE_URL cannot be used with multiple REPOS — it would point every repo's clone at the same git remote.");
  }
  const providers = await resolveProvidersForRepos(repos);
  const common = readCommonEnv();
  const { testCommand, testScript } = readTestConfig();
  const autoMerge = env("AUTO_MERGE") === "true";
  const testCombinedBumpInput = env("TEST_COMBINED_BUMP");
  if (testCombinedBumpInput !== undefined && testCombinedBumpInput !== "true" && testCombinedBumpInput !== "false") {
    throw new Error(`TEST_COMBINED_BUMP must be "true" or "false", got "${testCombinedBumpInput}"`);
  }
  const testCombinedBump = testCombinedBumpInput !== undefined ? testCombinedBumpInput === "true" : undefined;
  const brain = buildBrain();

  const paths = resolveRepoPaths(
    repos,
    env("CLONE_DIR"),
    env("STATE_PATH"),
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/state" },
  );

  const outcomes: RepoRunOutcome<PollResult>[] = [];
  for (const repo of repos) {
    const { cloneDir, statePath } = paths.get(repo)!;
    const provider = providers.get(repo)!;
    try {
      const { remoteUrl, authHeader } = resolveGitRemote(provider);

      const result = await pollOnce({
        cloneDir,
        remoteUrl,
        authHeader,
        statePath,
        ...(testScript ? { testScript } : { testCommand }),
        prSource: provider.createPullRequestSource(),
        forgeOpsFor: (pr) => provider.createForgeOpsFor(pr),
        allowedActors: common.allowedActors,
        autoMerge,
        brain,
        ...(common.packageJsonPath ? { packageJsonPath: common.packageJsonPath } : {}),
        ...(testCombinedBump !== undefined ? { testCombinedBump } : {}),
      });

      logCompatResult(repo, result);
      outcomes.push({ repo, ok: true, result });
    } catch (error) {
      console.error(`[${repo}] FAILED this cycle, will retry next cycle — ${String(error)}`);
      outcomes.push({ repo, ok: false, error });
    }
  }
  return outcomes;
}

function readMaxTurns(): number | undefined {
  const input = env("MAX_TURNS");
  if (input === undefined) return undefined;
  const value = Number(input);
  if (!Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    throw new Error(`MAX_TURNS must be a positive integer, got "${input}"`);
  }
  return value;
}

function logTriageResult(repo: string, result: TriagePollResult): void {
  for (const { pr, result: prResult } of result.processed) {
    if (prResult.status === "skipped-actor") {
      console.log(`[${repo}] PR #${pr.number}: skipped — actor "${prResult.actor}" not allowed.`);
    } else if (prResult.status === "unsupported-bump") {
      console.log(`[${repo}] PR #${pr.number}: skipped — unsupported bump: ${prResult.bump.reason}`);
    } else {
      console.log(
        `[${repo}] PR #${pr.number}: triaged ${prResult.bump.name} ${prResult.bump.fromVersion} -> ` +
          `${prResult.bump.toVersion} (${prResult.triage.toolCalls.length} tool calls).`,
      );
    }
  }
  if (result.skippedAlreadySeen.length > 0) {
    console.log(
      `[${repo}] Skipped (already processed at current head): ${result.skippedAlreadySeen.map((pr) => `#${pr.number}`).join(", ")}`,
    );
  }
  for (const { pr, error } of result.failed) {
    console.error(`[${repo}] PR #${pr.number}: FAILED this cycle, will retry next cycle — ${String(error)}`);
  }
}

async function runTriageOnce(): Promise<RepoRunOutcome<TriagePollResult>[]> {
  const repos = readRepoList();
  if (repos.length > 1 && env("REMOTE_URL")) {
    throw new Error("REMOTE_URL cannot be used with multiple REPOS — it would point every repo's clone at the same git remote.");
  }
  const providers = await resolveProvidersForRepos(repos);
  const common = readCommonEnv();
  const maxTurns = readMaxTurns();
  const agentLoop = buildAgentLoop();

  const paths = resolveRepoPaths(
    repos,
    env("CLONE_DIR"),
    env("TRIAGE_STATE_PATH"),
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/triage-state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/triage-state" },
  );

  const outcomes: RepoRunOutcome<TriagePollResult>[] = [];
  for (const repo of repos) {
    const { cloneDir, statePath } = paths.get(repo)!;
    const provider = providers.get(repo)!;
    try {
      const { remoteUrl, authHeader } = resolveGitRemote(provider);

      const result = await pollTriageOnce({
        cloneDir,
        remoteUrl,
        authHeader,
        statePath,
        prSource: provider.createPullRequestSource(),
        forgeOpsFor: (pr) => provider.createForgeOpsFor(pr),
        agentLoop,
        allowedActors: common.allowedActors,
        ...(maxTurns !== undefined ? { maxTurns } : {}),
        ...(common.packageJsonPath ? { packageJsonPath: common.packageJsonPath } : {}),
      });

      logTriageResult(repo, result);
      outcomes.push({ repo, ok: true, result });
    } catch (error) {
      console.error(`[${repo}] FAILED this cycle, will retry next cycle — ${String(error)}`);
      outcomes.push({ repo, ok: false, error });
    }
  }
  return outcomes;
}

const USAGE = `Usage: packdev-agents <compat|triage> [--once]

Env vars (both subcommands):
  REPO              "owner/repo" — one repo
  REPOS             "owner/a,owner/b,..." — a list, same PROVIDER/token for all
                    (mutually exclusive with REPO; each repo runs independently,
                    one repo failing doesn't stop the rest)
  REMOTE_URL        optional override for the git clone URL, single-REPO only —
                    by default this is derived from PROVIDER/REPO with credentials
                    applied per-request, never embedded in the URL itself
                    (see docs/self-hosted.md)
  PROVIDER          "github" (default) or "gitea"
  PROVIDER_MODULE   path (relative to cwd) or package specifier for a custom
                    provider module (overrides PROVIDER) — see docs/self-hosted.md
  GITHUB_TOKEN      required when PROVIDER=github
  GITEA_URL, GITEA_TOKEN, GITEA_USERNAME   required when PROVIDER=gitea
  ALLOWED_ACTORS, PACKAGE_JSON_PATH, POLL_INTERVAL_SECONDS   optional
                    (POLL_INTERVAL_SECONDS must be a positive number; only used without --once)
  CLONE_DIR         optional — one repo: the clone dir itself (default ./.packdev-agents/repo).
                    REPOS list: the root dir, namespaced one subdir per repo
                    (default ./.packdev-agents/repos)

compat-only:
  TEST_COMMAND | TEST_SCRIPT   exactly one required
  STATE_PATH        optional — one repo: the state file itself (default ./.packdev-agents/state.json).
                    REPOS list: the root dir, one file per repo (default ./.packdev-agents/state)
  AUTO_MERGE, TEST_COMBINED_BUMP
  BRAIN=anthropic|openai-compatible + ANTHROPIC_*/OPENAI_COMPATIBLE_*   optional failure-summary prose

triage-only:
  TRIAGE_STATE_PATH   same one-repo-vs-REPOS-list shape as STATE_PATH above
                       (default ./.packdev-agents/triage-state.json or .../triage-state)
  MAX_TURNS
  MODEL_PROVIDER=anthropic|openai-compatible (default anthropic) + ANTHROPIC_*/OPENAI_COMPATIBLE_*`;

async function main(): Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const once = rest.includes("--once");

  if (subcommand !== "compat" && subcommand !== "triage") {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const runOnce = subcommand === "compat" ? runCompatOnce : runTriageOnce;

  if (once) {
    const outcomes = await runOnce();
    const hasFailures = outcomes.some((outcome) => !outcome.ok || (outcome.result?.failed.length ?? 0) > 0);
    if (hasFailures) {
      process.exitCode = 1;
    }
    return;
  }

  const intervalSecondsInput = env("POLL_INTERVAL_SECONDS") ?? "300";
  const intervalSeconds = Number(intervalSecondsInput);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
    // A NaN/negative/zero interval would make setTimeout fire effectively
    // immediately, turning a poll loop into a tight loop hammering the
    // forge API — a plain typo in this env var must fail loudly here, not
    // manifest as a mysterious rate-limit ban later.
    throw new Error(`POLL_INTERVAL_SECONDS must be a positive number, got "${intervalSecondsInput}"`);
  }
  const loop = createPollLoop({ runOnce, sleep, intervalMs: intervalSeconds * 1000 });
  process.once("SIGINT", loop.stop);
  process.once("SIGTERM", loop.stop);

  await loop.start();
}

// Only auto-run when executed directly (`node dist/cli/index.js ...`), not
// when imported — lets tests import pure helpers above (resolveGitRemote,
// sameHttpOrigin) without triggering a real CLI run as an import side effect.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
