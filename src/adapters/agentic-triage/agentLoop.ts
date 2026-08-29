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
  apiKey: string;
  model?: string;
  baseUrl?: string;
  maxOutputTokens?: number;
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

/**
 * Drives a real Anthropic Messages API tool-use loop: send the prompt with
 * the given tools, execute whatever tool_use blocks come back via
 * executeTool, feed the results back as tool_result blocks, repeat until
 * the model stops asking for tools (stop_reason !== "tool_use") or
 * maxTurns is hit. Uses raw fetch, matching brain.ts's existing pattern —
 * no Anthropic SDK dependency.
 *
 * This is the ONLY place in the repo where a model gets to decide what to
 * DO next (which tool, with what arguments), not just what to SAY — see
 * docs/architecture.md "Agentic triage (experimental)". It is deliberately
 * kept out of the core pipeline: interpret()'s Verdict, and everything
 * auto-merge eligibility is computed from, still comes only from a real,
 * deterministic packdev compat run the model doesn't control.
 */
export async function runAgentLoop(
  options: RunAgentLoopOptions,
): Promise<RunAgentLoopResult> {
  const baseUrl = options.baseUrl ?? "https://api.anthropic.com";
  const model = options.model ?? "claude-sonnet-5";
  const maxTurns = options.maxTurns ?? 10;

  const anthropicTools = options.tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));

  const messages: AnthropicMessage[] = [{ role: "user", content: options.userPrompt }];
  const toolCalls: AgentToolCallLog[] = [];

  for (let turn = 1; turn <= maxTurns; turn++) {
    const response = await fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": options.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: options.maxOutputTokens ?? 2000,
        system: options.systemPrompt,
        tools: anthropicTools,
        messages,
      }),
    });

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
}
