import * as core from "@actions/core";
import * as github from "@actions/github";

import {
  runGithubPipeline,
  checkConclusionFor,
  checkConclusionForCrossFile,
  checkConclusionForIndependent,
} from "../../core/pipeline.js";
import { createOctokitOps } from "../shared/octokitOps.js";
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

  const testCommandInput = core.getInput("test-command");
  const testScriptInput = core.getInput("test-script");
  if (!testCommandInput && !testScriptInput) {
    core.setFailed('Exactly one of "test-command"/"test-script" is required, got neither.');
    return;
  }
  if (testCommandInput && testScriptInput) {
    core.setFailed('"test-command" and "test-script" are mutually exclusive, got both.');
    return;
  }
  const token = core.getInput("github-token", { required: true });
  const autoMerge = core.getBooleanInput("auto-merge");
  const failStepOnNonPass = core.getBooleanInput("fail-step-on-non-pass");
  const allowedActorsInput = core.getInput("allowed-actors");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const packageJsonPathInput = core.getInput("package-json-path");
  const testCombinedBumpInput = core.getInput("test-combined-bump");
  const testCombinedBump = testCombinedBumpInput ? core.getBooleanInput("test-combined-bump") : undefined;

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
    ...(testScriptInput ? { testScript: testScriptInput } : { testCommand: testCommandInput }),
    github: githubOps,
    allowedActors,
    autoMerge,
    brain: buildBrain(),
    ...(packageJsonPathInput ? { packageJsonPath: packageJsonPathInput } : {}),
    ...(testCombinedBump !== undefined ? { testCombinedBump } : {}),
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

  if (result.status === "static-incompatible") {
    core.info(
      `Static incompatible — ${result.bump.name} ${result.bump.fromVersion} → ` +
        `${result.bump.toVersion}: packdev api-diff found a missing export, skipped the ` +
        "sandboxed compat run.",
    );
    if (failStepOnNonPass) {
      core.setFailed(`packdev api-diff: static incompatible bump for ${result.bump.name}`);
    }
    return;
  }

  if (result.status === "cross-file-verdict") {
    // Delegates to pipeline.ts's own checkConclusionForCrossFile rather
    // than reimplementing the aggregation rule here — a divergence
    // between this file's copy and pipeline.ts's copy was flagged as a
    // real maintainability risk in review (they were in sync then, but
    // only by staying manually so); one shared implementation removes
    // that risk entirely.
    const worst = checkConclusionForCrossFile(result.results);
    core.setOutput("merged", String(result.merged));
    core.info(
      `Cross-file bump — ${result.bump.name} ${result.bump.toVersion} across ` +
        `${result.results.length} apps: ${worst} (merged: ${result.merged})`,
    );
    if (failStepOnNonPass && worst === "failure") {
      core.setFailed(`packdev compat: at least one app failed for ${result.bump.name} ${result.bump.toVersion}`);
    }
    return;
  }

  if (result.status === "independent-verdict") {
    const worst = checkConclusionForIndependent(result.results, result.combined);
    core.setOutput("merged", String(result.merged));
    core.info(
      `Independent bumps — ${result.results.length} packages to differing versions: ${worst} ` +
        `(combined: ${result.combined.kind}, merged: ${result.merged})`,
    );
    if (failStepOnNonPass && worst === "failure") {
      core.setFailed(`packdev compat: at least one bump (or the combined state) failed`);
    }
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
