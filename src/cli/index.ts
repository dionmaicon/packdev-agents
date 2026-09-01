import { createAnthropicBrain, createOpenAiCompatibleBrain, type Brain } from "../core/brain.js";
import type { CompatStepResult } from "../core/pipeline.js";
import { resolveProvider } from "../providers/registry.js";
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

function readCommonEnv() {
  const testCommand = env("TEST_COMMAND");
  const testScript = env("TEST_SCRIPT");
  if (!testCommand && !testScript) {
    throw new Error("Exactly one of TEST_COMMAND/TEST_SCRIPT env vars is required, got neither.");
  }
  if (testCommand && testScript) {
    throw new Error("TEST_COMMAND and TEST_SCRIPT are mutually exclusive, got both.");
  }
  const allowedActorsInput = env("ALLOWED_ACTORS");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  return {
    cloneDir: env("CLONE_DIR") ?? "./.packdev-agents/repo",
    testCommand,
    testScript,
    allowedActors,
    packageJsonPath: env("PACKAGE_JSON_PATH"),
  };
}

async function runCompatOnce(): Promise<PollResult> {
  const provider = await resolveProvider(process.env);
  const common = readCommonEnv();
  const statePath = env("STATE_PATH") ?? "./.packdev-agents/state.json";
  const remoteUrl = requireEnv("REMOTE_URL");
  const autoMerge = env("AUTO_MERGE") === "true";
  const testCombinedBumpInput = env("TEST_COMBINED_BUMP");
  const testCombinedBump = testCombinedBumpInput !== undefined ? testCombinedBumpInput === "true" : undefined;

  const result = await pollOnce({
    cloneDir: common.cloneDir,
    remoteUrl,
    statePath,
    ...(common.testScript ? { testScript: common.testScript } : { testCommand: common.testCommand }),
    prSource: provider.createPullRequestSource(),
    forgeOpsFor: (pr) => provider.createForgeOpsFor(pr),
    allowedActors: common.allowedActors,
    autoMerge,
    brain: buildBrain(),
    ...(common.packageJsonPath ? { packageJsonPath: common.packageJsonPath } : {}),
    ...(testCombinedBump !== undefined ? { testCombinedBump } : {}),
  });

  for (const { pr, result: prResult } of result.processed) {
    if (prResult.status === "verdict") {
      console.log(`PR #${pr.number}: ${prResult.verdict.kind} (merged: ${prResult.merged})`);
    } else if (prResult.status === "unsupported-bump") {
      console.log(`PR #${pr.number}: unsupported bump — ${prResult.bump.reason}`);
    } else if (prResult.status === "static-incompatible") {
      console.log(
        `PR #${pr.number}: static incompatible — ${prResult.bump.name} ` +
          `${prResult.bump.fromVersion} → ${prResult.bump.toVersion} (packdev api-diff, skipped compat)`,
      );
    } else if (prResult.status === "cross-file-verdict") {
      const kinds = prResult.results.map((r) => stepKindLabel(r.step)).join(", ");
      console.log(
        `PR #${pr.number}: cross-file — ${prResult.bump.name} ${prResult.bump.toVersion} across ` +
          `${prResult.results.length} apps [${kinds}] (merged: ${prResult.merged})`,
      );
    } else if (prResult.status === "independent-verdict") {
      const kinds = prResult.results.map((r) => stepKindLabel(r.step)).join(", ");
      console.log(
        `PR #${pr.number}: independent bumps — ${prResult.results.length} packages [${kinds}], ` +
          `combined: ${prResult.combined.kind} (merged: ${prResult.merged})`,
      );
    }
  }
  if (result.skippedAlreadySeen.length > 0) {
    console.log(
      `Skipped (already processed at current head): ${result.skippedAlreadySeen.map((pr) => `#${pr.number}`).join(", ")}`,
    );
  }
  for (const { pr, error } of result.failed) {
    console.error(`PR #${pr.number}: FAILED this cycle, will retry next cycle — ${String(error)}`);
  }

  return result;
}

async function runTriageOnce(): Promise<TriagePollResult> {
  const provider = await resolveProvider(process.env);
  const common = readCommonEnv();
  // Separate state file from compat's own — see poll.ts's TriagePollOptions doc comment.
  const statePath = env("TRIAGE_STATE_PATH") ?? "./.packdev-agents/triage-state.json";
  const remoteUrl = requireEnv("REMOTE_URL");
  const maxTurnsInput = env("MAX_TURNS");

  const result = await pollTriageOnce({
    cloneDir: common.cloneDir,
    remoteUrl,
    statePath,
    prSource: provider.createPullRequestSource(),
    forgeOpsFor: (pr) => provider.createForgeOpsFor(pr),
    agentLoop: buildAgentLoop(),
    allowedActors: common.allowedActors,
    ...(maxTurnsInput ? { maxTurns: Number(maxTurnsInput) } : {}),
    ...(common.packageJsonPath ? { packageJsonPath: common.packageJsonPath } : {}),
  });

  for (const { pr, result: prResult } of result.processed) {
    if (prResult.status === "skipped-actor") {
      console.log(`PR #${pr.number}: skipped — actor "${prResult.actor}" not allowed.`);
    } else if (prResult.status === "unsupported-bump") {
      console.log(`PR #${pr.number}: skipped — unsupported bump: ${prResult.bump.reason}`);
    } else {
      console.log(
        `PR #${pr.number}: triaged ${prResult.bump.name} ${prResult.bump.fromVersion} -> ` +
          `${prResult.bump.toVersion} (${prResult.triage.toolCalls.length} tool calls).`,
      );
    }
  }
  if (result.skippedAlreadySeen.length > 0) {
    console.log(
      `Skipped (already processed at current head): ${result.skippedAlreadySeen.map((pr) => `#${pr.number}`).join(", ")}`,
    );
  }
  for (const { pr, error } of result.failed) {
    console.error(`PR #${pr.number}: FAILED this cycle, will retry next cycle — ${String(error)}`);
  }

  return result;
}

const USAGE = `Usage: packdev-agents <compat|triage> [--once]

Env vars (both subcommands):
  REPO              "owner/repo"
  REMOTE_URL        git remote to clone (must include auth if private, e.g. https://user:token@host/owner/repo.git)
  PROVIDER          "github" (default) or "gitea"
  PROVIDER_MODULE   path to a custom provider module (overrides PROVIDER) — see docs
  GITHUB_TOKEN      required when PROVIDER=github
  GITEA_URL, GITEA_TOKEN   required when PROVIDER=gitea
  TEST_COMMAND | TEST_SCRIPT   exactly one required
  ALLOWED_ACTORS, PACKAGE_JSON_PATH, CLONE_DIR, POLL_INTERVAL_SECONDS   optional

compat-only:
  STATE_PATH, AUTO_MERGE, TEST_COMBINED_BUMP
  BRAIN=anthropic|openai-compatible + ANTHROPIC_*/OPENAI_COMPATIBLE_*   optional failure-summary prose

triage-only:
  TRIAGE_STATE_PATH, MAX_TURNS
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
    const result = await runOnce();
    if (result.failed.length > 0) {
      process.exitCode = 1;
    }
    return;
  }

  const intervalSeconds = Number(env("POLL_INTERVAL_SECONDS") ?? "300");
  const loop = createPollLoop({ runOnce, sleep, intervalMs: intervalSeconds * 1000 });
  process.once("SIGINT", loop.stop);
  process.once("SIGTERM", loop.stop);

  await loop.start();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
