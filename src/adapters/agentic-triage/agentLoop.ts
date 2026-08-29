export interface AgentTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AgentToolCall {
  name: string;
  input: Record<string, unknown>;
}

/** One tool call this run made and what it got back — kept for transparency in the final report/comment. */
export interface AgentToolCallLog {
  name: string;
  input: Record<string, unknown>;
  /** The tool's raw JSON-as-text result, or the error message if execution threw. */
  result: string;
  isError: boolean;
}

export interface RunAgentLoopOptions {
  systemPrompt: string;
  userPrompt: string;
  tools: AgentTool[];
  /** Actually executes a tool call — the caller owns what "executing" means (e.g. the MCP session). */
  executeTool: (call: AgentToolCall) => Promise<{ text: string; isError: boolean }>;
  /** Hard cap on request/response round-trips, independent of how many tool calls each turn makes. Guards against a runaway loop. */
  maxTurns?: number;
}

export interface RunAgentLoopResult {
  /** The model's final text-only response — the triage report. */
  report: string;
  toolCalls: AgentToolCallLog[];
  turns: number;
}

/**
 * One backend that can drive a real tool-use loop. Deliberately the same
 * shape as core/brain.ts's `Brain` interface (one method, multiple factory
 * functions per backend) — see createAnthropicAgentLoop /
 * createOpenAiCompatibleAgentLoop below. This is the ONLY place in the
 * repo where a model gets to decide what to DO next (which tool, with what
 * arguments), not just what to SAY — see docs/architecture.md "Agentic
 * triage (experimental)". Kept out of the core pipeline entirely:
 * interpret()'s Verdict, and everything auto-merge eligibility is computed
 * from, still comes only from a real, deterministic packdev compat run no
 * model controls.
 */
export interface AgentLoop {
  run(options: RunAgentLoopOptions): Promise<RunAgentLoopResult>;
}

// --- Anthropic Messages API backend ---

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | { type: string };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string;
}

export interface AnthropicAgentLoopConfig {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
  /**
   * Hard cap per HTTP request, not per turn or per whole run — a stuck
   * provider (hung connection, no response ever) would otherwise block
   * forever with nothing to catch it locally; in CI that means paying for
   * a runner that never finishes on its own. Defaults to 90s: real
   * reasoning-heavy responses observed in practice complete in well under
   * that per single request (see docs/architecture.md "Agentic triage"),
   * so this should only ever fire on a genuine stall, not a slow-but-
   * working call. This is the fail-FAST guard; a CI job-level
   * `timeout-minutes` is still the actual cost backstop — see
   * agentic-triage-action/action.yml's top comment.
   */
  requestTimeoutMs?: number;
}

/**
 * Hosted Anthropic Messages API. Uses raw fetch, matching brain.ts's
 * existing convention — no Anthropic SDK dependency.
 */
export function createAnthropicAgentLoop(config: AnthropicAgentLoopConfig): AgentLoop {
  const baseUrl = config.baseUrl ?? "https://api.anthropic.com";
  const model = config.model ?? "claude-sonnet-5";
  const requestTimeoutMs = config.requestTimeoutMs ?? 90_000;

  return {
    async run(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
      const maxTurns = options.maxTurns ?? 10;
      const tools = options.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      }));

      const messages: AnthropicMessage[] = [{ role: "user", content: options.userPrompt }];
      const toolCalls: AgentToolCallLog[] = [];

      for (let turn = 1; turn <= maxTurns; turn++) {
        let response: Response;
        try {
          response = await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": config.apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: config.maxOutputTokens ?? 8000,
              system: options.systemPrompt,
              tools,
              messages,
            }),
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error(
              `Anthropic API request timed out after ${requestTimeoutMs}ms (turn ${turn}) — ` +
                "the provider appears stuck, not just slow.",
            );
          }
          throw error;
        }

        if (!response.ok) {
          throw new Error(`Anthropic API error ${response.status}: ${await response.text()}`);
        }

        const body = (await response.json()) as AnthropicResponse;
        const toolUseBlocks = body.content.filter(
          (block): block is AnthropicToolUseBlock => block.type === "tool_use",
        );

        if (body.stop_reason !== "tool_use" || toolUseBlocks.length === 0) {
          const text = body.content
            .filter((block): block is AnthropicTextBlock => block.type === "text")
            .map((block) => block.text)
            .join("\n")
            .trim();
          if (!text) {
            throw new Error(
              `Anthropic response had no text content and stop_reason "${body.stop_reason}" wasn't "tool_use"`,
            );
          }
          return { report: text, toolCalls, turns: turn };
        }

        messages.push({ role: "assistant", content: body.content });

        const toolResults: AnthropicContentBlock[] = [];
        for (const block of toolUseBlocks) {
          let text: string;
          let isError: boolean;
          try {
            const result = await options.executeTool({ name: block.name, input: block.input });
            text = result.text;
            isError = result.isError;
          } catch (error) {
            text = error instanceof Error ? error.message : String(error);
            isError = true;
          }
          toolCalls.push({ name: block.name, input: block.input, result: text, isError });
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: text,
            ...(isError ? { is_error: true } : {}),
          } as AnthropicContentBlock);
        }
        messages.push({ role: "user", content: toolResults });
      }

      throw new Error(`Agent loop exceeded maxTurns (${maxTurns}) without a final text response`);
    },
  };
}

// --- OpenAI-compatible chat/completions backend ---
// Covers hosted OpenAI, Z.ai's GLM Coding Plan endpoint
// (https://api.z.ai/api/coding/paas/v4), and any local OpenAI-compatible
// endpoint (Ollama, vLLM). Genuinely different wire format from Anthropic's
// — not just pointed at a compatibility shim: tools nest under
// {type:"function", function:{...}}, tool calls come back as
// message.tool_calls[] with arguments as a JSON string (not an object),
// and tool results are separate role:"tool" messages keyed by
// tool_call_id, not content blocks inside a role:"user" message.

interface OpenAiToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAiToolCall[];
  tool_call_id?: string;
}

interface OpenAiChatCompletionResponse {
  choices: Array<{
    message: OpenAiMessage;
    finish_reason?: string;
  }>;
}

export interface OpenAiCompatibleAgentLoopConfig {
  /** e.g. https://api.z.ai/api/coding/paas/v4, https://api.openai.com/v1, http://localhost:11434/v1 (Ollama) */
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxOutputTokens?: number;
  /** Same rationale as AnthropicAgentLoopConfig.requestTimeoutMs — a per-request fail-fast guard, not a whole-run budget. Defaults to 90s. */
  requestTimeoutMs?: number;
}

export function createOpenAiCompatibleAgentLoop(config: OpenAiCompatibleAgentLoopConfig): AgentLoop {
  const requestTimeoutMs = config.requestTimeoutMs ?? 90_000;

  return {
    async run(options: RunAgentLoopOptions): Promise<RunAgentLoopResult> {
      const maxTurns = options.maxTurns ?? 10;
      const tools = options.tools.map((tool) => ({
        type: "function" as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.inputSchema,
        },
      }));

      const messages: OpenAiMessage[] = [
        { role: "system", content: options.systemPrompt },
        { role: "user", content: options.userPrompt },
      ];
      const toolCalls: AgentToolCallLog[] = [];

      for (let turn = 1; turn <= maxTurns; turn++) {
        let response: Response;
        try {
          response = await fetch(`${config.baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            },
            body: JSON.stringify({
              model: config.model,
              max_tokens: config.maxOutputTokens ?? 8000,
              tools,
              messages,
            }),
            signal: AbortSignal.timeout(requestTimeoutMs),
          });
        } catch (error) {
          if (error instanceof Error && error.name === "TimeoutError") {
            throw new Error(
              `OpenAI-compatible API request timed out after ${requestTimeoutMs}ms (turn ${turn}) ` +
                "— the provider appears stuck, not just slow.",
            );
          }
          throw error;
        }

        if (!response.ok) {
          throw new Error(
            `OpenAI-compatible API error ${response.status}: ${await response.text()}`,
          );
        }

        const body = (await response.json()) as OpenAiChatCompletionResponse;
        const choice = body.choices[0];
        if (!choice) {
          throw new Error("OpenAI-compatible response had no choices[0]");
        }
        const message = choice.message;
        const requestedToolCalls = message.tool_calls ?? [];

        if (requestedToolCalls.length === 0) {
          const text = (message.content ?? "").trim();
          if (!text) {
            const lengthHint =
              choice.finish_reason === "length"
                ? " — the model was cut off by max_tokens before producing any content " +
                  "(some models spend a large, invisible token budget on chain-of-thought " +
                  "reasoning before the visible response even starts); raise maxOutputTokens."
                : "";
            throw new Error(
              `OpenAI-compatible response had no message content and no tool_calls ` +
                `(finish_reason: "${choice.finish_reason}")${lengthHint}`,
            );
          }
          return { report: text, toolCalls, turns: turn };
        }

        messages.push(message);

        for (const call of requestedToolCalls) {
          let input: Record<string, unknown>;
          try {
            input = JSON.parse(call.function.arguments) as Record<string, unknown>;
          } catch (error) {
            throw new Error(
              `OpenAI-compatible tool call "${call.function.name}" had unparseable arguments: ` +
                `${call.function.arguments} (${String(error)})`,
            );
          }

          let text: string;
          let isError: boolean;
          try {
            const result = await options.executeTool({ name: call.function.name, input });
            text = result.text;
            isError = result.isError;
          } catch (error) {
            text = error instanceof Error ? error.message : String(error);
            isError = true;
          }
          toolCalls.push({ name: call.function.name, input, result: text, isError });
          messages.push({ role: "tool", tool_call_id: call.id, content: text });
        }
      }

      throw new Error(`Agent loop exceeded maxTurns (${maxTurns}) without a final text response`);
    },
  };
}
