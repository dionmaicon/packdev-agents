import * as githubApi from "@actions/github";

import { createAnthropicBrain, createOpenAiCompatibleBrain, type Brain } from "../../core/brain.js";
import { createOctokitOps } from "../github-action/octokitOps.js";
import { createOctokitPullRequestSource } from "./discoverPRs.js";
import { pollOnce } from "./poll.js";

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

async function runOnce(): Promise<void> {
  const [owner, repo] = requireEnv("REPO").split("/");
  if (!owner || !repo) {
    throw new Error(`REPO must be "owner/repo", got "${env("REPO")}"`);
  }

  const token = requireEnv("GITHUB_TOKEN");
  const remoteUrl = env("REMOTE_URL") ?? `https://github.com/${owner}/${repo}.git`;
  const cloneDir = env("CLONE_DIR") ?? "./.packdev-agents/repo";
  const statePath = env("STATE_PATH") ?? "./.packdev-agents/state.json";
  const testCommand = requireEnv("TEST_COMMAND");
  const autoMerge = env("AUTO_MERGE") === "true";
  const allowedActorsInput = env("ALLOWED_ACTORS");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const octokit = githubApi.getOctokit(token);
  const prSource = createOctokitPullRequestSource({ octokit, owner, repo });
  const brain = buildBrain();

  const result = await pollOnce({
    cloneDir,
    remoteUrl,
    statePath,
    testCommand,
    prSource,
    githubOpsFor: (pr) =>
      createOctokitOps({ octokit, owner, repo, prNumber: pr.number, headSha: pr.headSha }),
    allowedActors,
    autoMerge,
    brain,
  });

  for (const { pr, result: prResult } of result.processed) {
    if (prResult.status === "verdict") {
      console.log(`PR #${pr.number}: ${prResult.verdict.kind} (merged: ${prResult.merged})`);
    } else if (prResult.status === "unsupported-bump") {
      console.log(`PR #${pr.number}: unsupported bump — ${prResult.bump.reason}`);
    }
  }
  if (result.skippedAlreadySeen.length > 0) {
    console.log(
      `Skipped (already processed at current head): ${result.skippedAlreadySeen.map((pr) => `#${pr.number}`).join(", ")}`,
    );
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes("--once");

  if (once) {
    await runOnce();
    return;
  }

  const intervalSeconds = Number(env("POLL_INTERVAL_SECONDS") ?? "300");
  let stopped = false;
  const stop = (): void => {
    stopped = true;
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  while (!stopped) {
    try {
      await runOnce();
    } catch (error) {
      console.error("Poll failed:", error);
    }
    if (stopped) break;
    await sleep(intervalSeconds * 1000);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
