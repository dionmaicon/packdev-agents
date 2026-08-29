import { connectPackdevMcp } from "./mcpClient.js";
import type { AgentLoop, AgentToolCallLog } from "./agentLoop.js";
import type { Bump } from "../../core/extractBump.js";

export interface RunAgenticTriageOptions {
  /** Directory with the bump's package.json — same appDir runCompat/runApiDiff would use. */
  appDir: string;
  bump: Bump;
  /** Which model backend drives the loop — createAnthropicAgentLoop or createOpenAiCompatibleAgentLoop. */
  agentLoop: AgentLoop;
  maxTurns?: number;
  /** Test-only escape hatch, forwarded to connectPackdevMcp. */
  binPathOverride?: string | undefined;
}

export interface AgenticTriageResult {
  report: string;
  toolCalls: AgentToolCallLog[];
  turns: number;
}

function buildSystemPrompt(): string {
  return (
    "You are triaging a single dependency version bump for a pull request, using packdev's " +
    "own tools (api_diff, compat, dupes, behavior_diff) — the same tools a developer would " +
    "reach for by hand. You decide which to call, in which order, and when you have enough " +
    "evidence to stop.\n\n" +
    "Ground rules:\n" +
    "- api_diff is static and cheap (no install) but a version can come back apiCompatible: " +
    "null, which means \"couldn't verify\", not \"compatible\" — never report that as a pass.\n" +
    "- compat is the only tool that can see a real runtime/build failure. Always pass BOTH the " +
    "currently-installed version and the candidate in `versions`, so the response's control " +
    "result tells you whether the app's own test harness is healthy before you trust anything " +
    "else it reports. If controlFailed is true, the harness is broken — that is not evidence " +
    "about the bump either way.\n" +
    "- dupes matters most after compat: a duplicate-copy count that increased is a real " +
    "regression a passing test command can still miss (DI singletons, instanceof checks).\n" +
    "- Do not claim a level of confidence stronger than the tool evidence you actually gathered. " +
    "If you only ran api_diff, say so, and say what running compat would add.\n\n" +
    "When you're done, write a short final report (plain text, no further tool calls) for a " +
    "developer reviewing the PR: your conclusion, the evidence for it, and any caveat about " +
    "what you didn't check. This is advisory only — it is never used to auto-merge anything."
  );
}

function buildUserPrompt(bump: Bump): string {
  const groupNote =
    bump.group && bump.group.length > 0
      ? ` This PR bumps ${bump.name} together with ${bump.group.join(", ")} — all to the exact ` +
        `same target version (${bump.toVersion}), a version-locked family moving as a group. ` +
        `When you call the "compat" tool, pass "group": [${bump.group.map((n) => `"${n}"`).join(", ")}] ` +
        "so the sandbox pins them together too, matching what this PR actually changes — testing " +
        `${bump.name} in isolation while its group silently stays on the old version would not ` +
        "answer this PR."
      : "";
  return (
    `Triage this bump: **${bump.name}** \`${bump.fromVersion}\` → \`${bump.toVersion}\` ` +
    `(${bump.section}, ${bump.packageJsonPath}).${groupNote} Investigate using the available ` +
    "tools and report your findings."
  );
}

/**
 * Runs the experimental agentic-triage path: a real coding-agent tool-use
 * loop (see agentLoop.ts) driving packdev's own MCP server (see
 * mcpClient.ts) against this bump, deciding for itself which of api_diff /
 * compat / dupes / behavior_diff to call and in what order — unlike the
 * core pipeline (extractBump -> compat -> interpret -> report), which is a
 * fixed, deterministic sequence with no model in the decision loop.
 *
 * Deliberately kept OUT of core and out of the Verdict/auto-merge
 * machinery: this always produces advisory prose, never a Verdict, and is
 * never auto-merge eligible on its own conclusion. See
 * docs/architecture.md "Agentic triage (experimental)".
 */
export async function runAgenticTriage(
  options: RunAgenticTriageOptions,
): Promise<AgenticTriageResult> {
  const session = await connectPackdevMcp({
    cwd: options.appDir,
    binPathOverride: options.binPathOverride,
  });

  try {
    const tools = await session.listTools();

    const result = await options.agentLoop.run({
      systemPrompt: buildSystemPrompt(),
      userPrompt: buildUserPrompt(options.bump),
      tools,
      executeTool: (call) => session.callTool(call.name, call.input),
      ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
    });

    return result;
  } finally {
    await session.close();
  }
}
