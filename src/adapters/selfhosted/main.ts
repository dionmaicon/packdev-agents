import * as githubApi from "@actions/github";

import { createAnthropicBrain, createOpenAiCompatibleBrain, type Brain } from "../../core/brain.js";
import type { CompatStepResult } from "../../core/pipeline.js";
import { createOctokitOps } from "../shared/octokitOps.js";
import { createOctokitPullRequestSource } from "./discoverPRs.js";
import { pollOnce, type PollResult } from "./poll.js";
import { createPollLoop } from "./loop.js";

function env(name: string): string | undefined {
  return process.env[name];
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
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
        ...(env("OPENAI_COMPATIBLE_API_KEY")
          ? { apiKey: env("OPENAI_COMPATIBLE_API_KEY")! }
          : {}),
      });
    default:
      throw new Error(
        `Unknown BRAIN "${kind}" — expected "none", "anthropic", or "openai-compatible"`,
      );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared by the cross-file/independent-verdict log lines below — avoids the "add a step kind, forget a call site" trap that fixing this file's own compile errors just caught once already. */
function stepKindLabel(step: CompatStepResult): string {
  switch (step.kind) {
    case "static-incompatible":
      return "STATIC_INCOMPATIBLE";
    case "verdict":
      return step.verdict.kind;
  }
}

async function runOnce(): Promise<PollResult> {
  const [owner, repo] = requireEnv("REPO").split("/");
  if (!owner || !repo) {
    throw new Error(`REPO must be "owner/repo", got "${env("REPO")}"`);
  }

  const token = requireEnv("GITHUB_TOKEN");
  const remoteUrl = env("REMOTE_URL") ?? `https://github.com/${owner}/${repo}.git`;
  const cloneDir = env("CLONE_DIR") ?? "./.packdev-agents/repo";
  const statePath = env("STATE_PATH") ?? "./.packdev-agents/state.json";
  const testCommand = env("TEST_COMMAND");
  const testScript = env("TEST_SCRIPT");
  if (!testCommand && !testScript) {
    throw new Error('Exactly one of TEST_COMMAND/TEST_SCRIPT env vars is required, got neither.');
  }
  if (testCommand && testScript) {
    throw new Error("TEST_COMMAND and TEST_SCRIPT are mutually exclusive, got both.");
  }
  const autoMerge = env("AUTO_MERGE") === "true";
  const allowedActorsInput = env("ALLOWED_ACTORS");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const packageJsonPath = env("PACKAGE_JSON_PATH");
  const testCombinedBumpInput = env("TEST_COMBINED_BUMP");
  const testCombinedBump = testCombinedBumpInput !== undefined ? testCombinedBumpInput === "true" : undefined;

  const octokit = githubApi.getOctokit(token);
  const prSource = createOctokitPullRequestSource({ octokit, owner, repo });
  const brain = buildBrain();

  const result = await pollOnce({
    cloneDir,
    remoteUrl,
    statePath,
    ...(testScript ? { testScript } : { testCommand }),
    prSource,
    githubOpsFor: (pr) =>
      createOctokitOps({ octokit, owner, repo, prNumber: pr.number, headSha: pr.headSha }),
    allowedActors,
    autoMerge,
    brain,
    ...(packageJsonPath ? { packageJsonPath } : {}),
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
  // Logged, not thrown: one PR failing must not take down the whole poll
  // cycle or the process running it — see pollOnce's doc comment. These
  // PRs weren't marked as seen, so they're retried next cycle. main()'s
  // --once path still surfaces this as a nonzero exit code (see below) —
  // logging alone isn't enough for a cron/scheduler to notice.
  for (const { pr, error } of result.failed) {
    console.error(`PR #${pr.number}: FAILED this cycle, will retry next cycle — ${String(error)}`);
  }

  return result;
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  if (once) {
    const result = await runOnce();
    // Per-PR isolation (pollOnce's own try/catch) means a failed PR no
    // longer throws all the way up to main().catch below, which used to
    // set process.exitCode = 1 automatically. Without this check, a
    // cron/scheduler running --once would see exit 0 and treat a batch
    // with real failures as a healthy run — caught in review.
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
