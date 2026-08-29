import { render } from "./report.js";
import type { Verdict } from "./interpret.js";

export interface SummarizeFailureInput {
  packageName: string;
  fromVersion: string | null;
  toVersion: string;
  verdictKind: Verdict["kind"];
  /** Raw failure/install/test output. Never pre-truncated — implementations decide their own budget. */
  output: string;
}

/**
 * Deliberately narrow: the only job is turning raw failure output into
 * readable prose for a PR comment. A Brain NEVER decides pass/fail —
 * interpret() already produced that verdict as a pure function over
 * packdev's report, and keeping the merge decision out of the model is
 * what makes it reproducible and auditable regardless of which model (or
 * none) is configured. See docs/architecture.md "Model backend".
 */
export interface Brain {
  summarizeFailure(input: SummarizeFailureInput): Promise<string>;
}

function buildPrompt(input: SummarizeFailureInput): string {
  const range = input.fromVersion
    ? `${input.fromVersion} → ${input.toVersion}`
    : input.toVersion;
  return (
    `A dependency compatibility check for "${input.packageName}" (${range}) produced the ` +
    `verdict ${input.verdictKind}. Summarize the following raw output in 2-4 sentences for a ` +
    "developer reviewing a pull request. State the concrete cause if it's visible in the " +
    "output; don't speculate beyond what's shown. Do not restate the verdict itself.\n\n" +
    `---\n${input.output}\n---`
  );
}

export interface AnthropicBrainConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
}

/** Hosted Anthropic Messages API. */
export function createAnthropicBrain(config: AnthropicBrainConfig): Brain {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  const model = config.model ?? "claude-sonnet-5";

  return {
    async summarizeFailure(input: SummarizeFailureInput): Promise<string> {
      const response = await fetch(`${baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: config.maxOutputTokens ?? 300,
          messages: [{ role: "user", content: buildPrompt(input) }],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `Anthropic API error ${response.status}: ${await response.text()}`,
        );
      }

      const body = (await response.json()) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = body.content?.find((block) => block.type === "text")?.text;
      if (!text) {
        throw new Error("Anthropic API response had no text content block");
      }
      return text.trim();
    },
  };
}

export interface OpenAiCompatibleBrainConfig {
  /** e.g. https://api.openai.com/v1, http://localhost:11434/v1 (Ollama), http://localhost:8000/v1 (vLLM) */
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxOutputTokens?: number;
}

/** Covers hosted OpenAI and any local OpenAI-compatible endpoint (Ollama, vLLM). */
export function createOpenAiCompatibleBrain(config: OpenAiCompatibleBrainConfig): Brain {
  return {
    async summarizeFailure(input: SummarizeFailureInput): Promise<string> {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: config.model,
          max_tokens: config.maxOutputTokens ?? 300,
          messages: [{ role: "user", content: buildPrompt(input) }],
        }),
      });

      if (!response.ok) {
        throw new Error(
          `OpenAI-compatible API error ${response.status}: ${await response.text()}`,
        );
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const text = body.choices?.[0]?.message?.content;
      if (!text) {
        throw new Error("OpenAI-compatible API response had no message content");
      }
      return text.trim();
    },
  };
}

function outputToSummarize(verdict: Verdict): string | null {
  switch (verdict.kind) {
    case "HARNESS_BROKEN":
      return verdict.report.control?.output ?? null;
    case "INSTALL_FAILED":
    case "INCOMPATIBLE": {
      const combined = verdict.failedVersions
        .map((v) => v.output)
        .filter((output): output is string => Boolean(output))
        .join("\n---\n");
      return combined || null;
    }
    case "NO_CONTROL":
    case "NOTHING_TESTED":
    case "PASSED_WEAK":
    case "PASSED":
      return null;
  }
}

/**
 * Renders a Verdict the same way report.ts's render() does, then — only
 * when a Brain is configured AND the verdict carries real failure output
 * to summarize — inserts a prose summary ahead of the raw output block.
 * The raw output is never removed, only supplemented. A missing or
 * failing Brain call falls back to the unmodified render() output; a
 * degraded model degrades the comment's prose, never the verdict itself.
 */
export async function renderWithBrain(
  verdict: Verdict,
  brain?: Brain,
): Promise<string> {
  const base = render(verdict);
  if (!brain) return base;

  const output = outputToSummarize(verdict);
  if (!output) return base;

  const candidates =
    "failedVersions" in verdict
      ? verdict.failedVersions
      : verdict.report.control
        ? [verdict.report.control]
        : [];
  const toVersion = candidates[0]?.version ?? verdict.report.package;

  let summary: string;
  try {
    summary = await brain.summarizeFailure({
      packageName: verdict.report.package,
      fromVersion: verdict.report.control?.version ?? null,
      toVersion,
      verdictKind: verdict.kind,
      output,
    });
  } catch {
    return base;
  }

  return `${base}\n\n**Summary:** ${summary}`;
}
