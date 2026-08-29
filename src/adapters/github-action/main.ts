import * as core from "@actions/core";
import * as github from "@actions/github";

import { runGithubPipeline, checkConclusionFor } from "./pipeline.js";
import { createOctokitOps } from "./octokitOps.js";
import { createAnthropicBrain, createOpenAiCompatibleBrain, type Brain } from "../../core/brain.js";

function buildBrain(): Brain | undefined {
  const kind = core.getInput("brain") || "none";

  switch (kind) {
    case "none":
      return undefined;

    case "anthropic":
      return createAnthropicBrain({
        apiKey: core.getInput("anthropic-api-key", { required: true }),
        ...(core.getInput("anthropic-model")
          ? { model: core.getInput("anthropic-model") }
          : {}),
      });

    case "openai-compatible":
      return createOpenAiCompatibleBrain({
        baseUrl: core.getInput("openai-compatible-base-url", { required: true }),
        model: core.getInput("openai-compatible-model", { required: true }),
        ...(core.getInput("openai-compatible-api-key")
          ? { apiKey: core.getInput("openai-compatible-api-key") }
          : {}),
      });

    default:
      throw new Error(
        `Unknown "brain" input "${kind}" — expected "none", "anthropic", or "openai-compatible"`,
      );
  }
}

async function run(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.setFailed("This action must be triggered by a pull_request event.");
    return;
  }

  const testCommand = core.getInput("test-command", { required: true });
  const token = core.getInput("github-token", { required: true });
  const autoMerge = core.getBooleanInput("auto-merge");
  const failStepOnNonPass = core.getBooleanInput("fail-step-on-non-pass");
  const allowedActorsInput = core.getInput("allowed-actors");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const githubOps = createOctokitOps({
    octokit,
    owner,
    repo,
    prNumber: pr.number,
    headSha: pr.head.sha,
  });

  const result = await runGithubPipeline({
    repoDir: process.cwd(),
    // SHAs, not branch names: actions/checkout may not create a local
    // branch ref for the base branch even with fetch-depth: 0, but the
    // base commit object itself is reachable, and git show/git archive
    // both work fine against a bare SHA.
    baseRef: pr.base.sha,
    headRef: pr.head.sha,
    actor: pr.user.login,
    testCommand,
    github: githubOps,
    allowedActors,
    autoMerge,
    brain: buildBrain(),
  });

  core.setOutput("status", result.status);

  if (result.status === "skipped-actor") {
    core.info(`Skipped — PR author "${result.actor}" is not in allowed-actors.`);
    return;
  }

  if (result.status === "unsupported-bump") {
    core.info(`Skipped — unsupported bump: ${result.bump.reason}`);
    return;
  }

  core.setOutput("verdict", result.verdict.kind);
  core.setOutput("merged", String(result.merged));
  core.info(`Verdict: ${result.verdict.kind} (merged: ${result.merged})`);

  if (failStepOnNonPass && checkConclusionFor(result.verdict) === "failure") {
    core.setFailed(`packdev compat verdict: ${result.verdict.kind}`);
  }
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
