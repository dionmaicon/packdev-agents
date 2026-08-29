import * as core from "@actions/core";
import * as github from "@actions/github";

import { runAgenticTriagePipeline } from "./pipeline.js";
import { createOctokitOps } from "../shared/octokitOps.js";
import { createAnthropicAgentLoop, createOpenAiCompatibleAgentLoop, type AgentLoop } from "./agentLoop.js";

/** Mirrors github-action/main.ts's buildBrain() selector — same "one interface, pick a backend by input" shape. */
function buildAgentLoop(): AgentLoop {
  const provider = core.getInput("model-provider") || "anthropic";
  const requestTimeoutMsInput = core.getInput("request-timeout-ms");
  const requestTimeoutMs = requestTimeoutMsInput ? Number(requestTimeoutMsInput) : undefined;
  const maxOutputTokensInput = core.getInput("max-output-tokens");
  const maxOutputTokens = maxOutputTokensInput ? Number(maxOutputTokensInput) : undefined;

  switch (provider) {
    case "anthropic":
      return createAnthropicAgentLoop({
        apiKey: core.getInput("anthropic-api-key", { required: true }),
        ...(core.getInput("anthropic-model") ? { model: core.getInput("anthropic-model") } : {}),
        ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      });

    case "openai-compatible":
      return createOpenAiCompatibleAgentLoop({
        baseUrl: core.getInput("openai-compatible-base-url", { required: true }),
        model: core.getInput("openai-compatible-model", { required: true }),
        ...(core.getInput("openai-compatible-api-key")
          ? { apiKey: core.getInput("openai-compatible-api-key") }
          : {}),
        ...(requestTimeoutMs ? { requestTimeoutMs } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
      });

    default:
      throw new Error(
        `Unknown "model-provider" input "${provider}" — expected "anthropic" or "openai-compatible"`,
      );
  }
}

/**
 * Entrypoint for the experimental agentic-triage Action — a SEPARATE step
 * from the main `packdev compat` action (adapters/github-action/main.ts),
 * meant to run alongside it on the same PR, not replace it. This one never
 * gates a merge: it always posts a neutral check run and an advisory
 * comment, regardless of what the model concludes. See
 * docs/architecture.md "Agentic triage (experimental)".
 */
async function run(): Promise<void> {
  const pr = github.context.payload.pull_request;
  if (!pr) {
    core.setFailed("This action must be triggered by a pull_request event.");
    return;
  }

  const token = core.getInput("github-token", { required: true });
  const allowedActorsInput = core.getInput("allowed-actors");
  const allowedActors = allowedActorsInput
    ? allowedActorsInput.split(",").map((s) => s.trim()).filter(Boolean)
    : undefined;
  const packageJsonPathInput = core.getInput("package-json-path");
  const maxTurnsInput = core.getInput("max-turns");
  const maxTurns = maxTurnsInput ? Number(maxTurnsInput) : undefined;

  const octokit = github.getOctokit(token);
  const { owner, repo } = github.context.repo;

  const githubOps = createOctokitOps({
    octokit,
    owner,
    repo,
    prNumber: pr.number,
    headSha: pr.head.sha,
  });

  const result = await runAgenticTriagePipeline({
    repoDir: process.cwd(),
    baseRef: pr.base.sha,
    headRef: pr.head.sha,
    actor: pr.user.login,
    github: githubOps,
    agentLoop: buildAgentLoop(),
    allowedActors,
    ...(maxTurns ? { maxTurns } : {}),
    ...(packageJsonPathInput ? { packageJsonPath: packageJsonPathInput } : {}),
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

  core.info(`Triaged ${result.bump.name} (${result.triage.toolCalls.length} tool calls).`);
  // Deliberately never core.setFailed() here on any triage outcome — this
  // path is advisory only, see the module doc comment above.
}

run().catch((error: unknown) => {
  core.setFailed(error instanceof Error ? error.message : String(error));
});
