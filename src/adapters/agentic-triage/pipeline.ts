import path from "node:path";

import { extractBump, isUnsupported, type Bump, type Unsupported } from "../../core/extractBump.js";
import { prepareWorkspace } from "../../core/prepareWorkspace.js";
import { DEFAULT_ALLOWED_ACTORS, type GitHubOps } from "../../core/pipeline.js";
import { runAgenticTriage, type AgenticTriageResult } from "./triage.js";
import type { AgentLoop } from "./agentLoop.js";

/** Distinct from core/pipeline.ts's COMMENT_MARKER so both can run on the same PR without clobbering each other's comment. */
export const AGENTIC_TRIAGE_COMMENT_MARKER = "<!-- packdev-agents:agentic-triage -->";

export interface RunAgenticTriagePipelineOptions {
  repoDir: string;
  baseRef: string;
  headRef: string;
  actor: string;
  github: GitHubOps;
  /** Which model backend drives the loop — createAnthropicAgentLoop or createOpenAiCompatibleAgentLoop. */
  agentLoop: AgentLoop;
  maxTurns?: number | undefined;
  packageJsonPath?: string | undefined;
  allowedActors?: string[] | undefined;
  /** Test-only escape hatch, forwarded to runAgenticTriage. */
  binPathOverride?: string | undefined;
}

export type RunAgenticTriagePipelineResult =
  | { status: "skipped-actor"; actor: string }
  | { status: "unsupported-bump"; bump: Unsupported }
  | { status: "triaged"; bump: Bump; triage: AgenticTriageResult };

function renderTriageComment(bump: Bump, triage: AgenticTriageResult): string {
  const lines: string[] = [];
  lines.push("### 🤖 Agentic triage (experimental, advisory only)");
  lines.push("");
  lines.push(`**${bump.name}**: \`${bump.fromVersion}\` → \`${bump.toVersion}\``);
  lines.push("");
  lines.push(triage.report);
  lines.push("");
  if (triage.toolCalls.length > 0) {
    lines.push("<details>");
    lines.push(`<summary>Tools called (${triage.toolCalls.length})</summary>`);
    lines.push("");
    for (const call of triage.toolCalls) {
      lines.push(`- \`${call.name}\`(${JSON.stringify(call.input)})${call.isError ? " — errored" : ""}`);
    }
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  lines.push(
    "_This is a separate, experimental path — a model decided which packdev tools to run and " +
      "in what order. It never gates a merge and carries no auto-merge weight; the `packdev " +
      "compat` check above (if present) is the one that does._",
  );
  return lines.join("\n");
}

/**
 * Runs the experimental agentic-triage path end to end: gate on actor,
 * extract the bump, prepare a workspace at the base ref (same as the core
 * pipeline), then hand off to runAgenticTriage and post the result as an
 * ADVISORY comment — always a neutral check run, never a merge call. This
 * is deliberately its own pipeline, not a mode of core/pipeline.ts: the
 * two are meant to run side by side on the same PR (see the distinct
 * comment marker above), one deterministic and merge-gating, one
 * exploratory and advisory.
 */
export async function runAgenticTriagePipeline(
  options: RunAgenticTriagePipelineOptions,
): Promise<RunAgenticTriagePipelineResult> {
  const allowedActors = options.allowedActors ?? DEFAULT_ALLOWED_ACTORS;
  if (!allowedActors.includes(options.actor)) {
    return { status: "skipped-actor", actor: options.actor };
  }

  const bump = await extractBump({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    headRef: options.headRef,
    ...(options.packageJsonPath ? { packageJsonPath: options.packageJsonPath } : {}),
  });

  if (isUnsupported(bump)) {
    const body =
      bump.bumps.length > 0
        ? `${AGENTIC_TRIAGE_COMMENT_MARKER}\n### 🤖 Agentic triage — ⏭️ Skipped\n\n${bump.reason}: ${bump.bumps
            .map((b) => `\`${b.name}\` ${b.fromVersion} → ${b.toVersion}`)
            .join(", ")}.`
        : `${AGENTIC_TRIAGE_COMMENT_MARKER}\n### 🤖 Agentic triage — ⏭️ Skipped\n\n${bump.reason}.`;

    await options.github.upsertComment({ marker: AGENTIC_TRIAGE_COMMENT_MARKER, body });
    return { status: "unsupported-bump", bump };
  }

  const workspace = await prepareWorkspace({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    packageJsonPath: bump.packageJsonPath,
  });

  let triage: AgenticTriageResult;
  try {
    const appDir = path.join(workspace.dir, path.dirname(bump.packageJsonPath));
    triage = await runAgenticTriage({
      appDir,
      bump,
      agentLoop: options.agentLoop,
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
      ...(options.binPathOverride ? { binPathOverride: options.binPathOverride } : {}),
    });
  } finally {
    await workspace.cleanup();
  }

  const body = `${AGENTIC_TRIAGE_COMMENT_MARKER}\n${renderTriageComment(bump, triage)}`;
  await options.github.upsertComment({ marker: AGENTIC_TRIAGE_COMMENT_MARKER, body });
  await options.github.createCheckRun({
    name: "packdev agentic triage",
    conclusion: "neutral",
    title: `${bump.name} ${bump.fromVersion} → ${bump.toVersion}: advisory triage complete`,
    summary: triage.report,
  });

  return { status: "triaged", bump, triage };
}
