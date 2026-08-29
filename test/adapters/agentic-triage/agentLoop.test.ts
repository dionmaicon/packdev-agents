import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  createAnthropicAgentLoop,
  createOpenAiCompatibleAgentLoop,
  type AgentTool,
} from "../../../src/adapters/agentic-triage/agentLoop.ts";

async function withFakeServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** Reads and JSON-parses the request body, then responds with the next scripted reply. */
function scriptedServer(replies: unknown[]) {
  let call = 0;
  const requestBodies: unknown[] = [];
  const handler = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      requestBodies.push(JSON.parse(raw));
      const reply = replies[call];
      call++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
  };
  return { handler, requestBodies };
}

const fakeTool: AgentTool = {
  name: "api_diff",
  description: "checks api compat",
  inputSchema: { type: "object", properties: { package: { type: "string" } }, required: ["package"] },
};

// --- Anthropic backend ---

test("createAnthropicAgentLoop: single tool_use turn then a final text response — executes the tool, feeds the result back, returns the report", async () => {
  const { handler, requestBodies } = scriptedServer([
    {
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "call_1", name: "api_diff", input: { package: "is-odd" } },
      ],
    },
    {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "The bump looks safe based on api-diff." }],
    },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const agentLoop = createAnthropicAgentLoop({ apiKey: "test-key", baseUrl });
    const result = await agentLoop.run({
      systemPrompt: "You are triaging a dependency bump.",
      userPrompt: "Investigate the bump.",
      tools: [fakeTool],
      executeTool: async (call) => {
        executed.push(call);
        return { text: '{"apiCompatible":true}', isError: false };
      },
    });

    assert.equal(result.report, "The bump looks safe based on api-diff.");
    assert.equal(result.turns, 2);
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], { name: "api_diff", input: { package: "is-odd" } });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.result, '{"apiCompatible":true}');
    assert.equal(result.toolCalls[0]!.isError, false);

    // Second request must carry the tool_result feeding the first call's output back.
    const secondRequest = requestBodies[1] as { messages: Array<{ role: string; content: unknown }> };
    const lastMessage = secondRequest.messages.at(-1) as { role: string; content: Array<{ type: string }> };
    assert.equal(lastMessage.role, "user");
    assert.equal(lastMessage.content[0]!.type, "tool_result");

    // First request declared the tool in Anthropic's expected shape.
    const firstRequest = requestBodies[0] as { tools: Array<{ name: string; input_schema: unknown }> };
    assert.equal(firstRequest.tools[0]!.name, "api_diff");
    assert.ok(firstRequest.tools[0]!.input_schema);
  });
});

test("createAnthropicAgentLoop: no tool_use on the first turn returns the text immediately, zero tool calls", async () => {
  const { handler } = scriptedServer([
    { stop_reason: "end_turn", content: [{ type: "text", text: "Nothing to check, skipping." }] },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createAnthropicAgentLoop({ apiKey: "test-key", baseUrl });
    const result = await agentLoop.run({
      systemPrompt: "sys",
      userPrompt: "go",
      tools: [fakeTool],
      executeTool: async () => {
        throw new Error("should never be called");
      },
    });

    assert.equal(result.report, "Nothing to check, skipping.");
    assert.equal(result.turns, 1);
    assert.equal(result.toolCalls.length, 0);
  });
});

test("createAnthropicAgentLoop: a tool execution that throws is logged as an error result and fed back, not thrown out of the loop", async () => {
  const { handler } = scriptedServer([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "api_diff", input: { package: "is-odd" } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Tool failed, reporting as inconclusive." }] },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createAnthropicAgentLoop({ apiKey: "test-key", baseUrl });
    const result = await agentLoop.run({
      systemPrompt: "sys",
      userPrompt: "go",
      tools: [fakeTool],
      executeTool: async () => {
        throw new Error("registry unreachable");
      },
    });

    assert.equal(result.report, "Tool failed, reporting as inconclusive.");
    assert.equal(result.toolCalls[0]!.isError, true);
    assert.match(result.toolCalls[0]!.result, /registry unreachable/);
  });
});

test("createAnthropicAgentLoop: exceeding maxTurns while the model keeps asking for tools is a hard error", async () => {
  const alwaysToolUse = {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "call_x", name: "api_diff", input: { package: "is-odd" } }],
  };
  const { handler } = scriptedServer([alwaysToolUse, alwaysToolUse, alwaysToolUse]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createAnthropicAgentLoop({ apiKey: "test-key", baseUrl });
    await assert.rejects(
      () =>
        agentLoop.run({
          systemPrompt: "sys",
          userPrompt: "go",
          tools: [fakeTool],
          maxTurns: 3,
          executeTool: async () => ({ text: "{}", isError: false }),
        }),
      /exceeded maxTurns/,
    );
  });
});

test("createAnthropicAgentLoop: non-2xx response is a hard error surfacing the status and body", async () => {
  await withFakeServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    },
    async (baseUrl) => {
      const agentLoop = createAnthropicAgentLoop({ apiKey: "test-key", baseUrl });
      await assert.rejects(
        () =>
          agentLoop.run({
            systemPrompt: "sys",
            userPrompt: "go",
            tools: [fakeTool],
            executeTool: async () => ({ text: "{}", isError: false }),
          }),
        /Anthropic API error 500/,
      );
    },
  );
});

// --- OpenAI-compatible backend (Z.ai, hosted OpenAI, local Ollama/vLLM) ---

test("createOpenAiCompatibleAgentLoop: single tool_calls turn then a final text response — executes the tool, feeds the result back via role:tool", async () => {
  const { handler, requestBodies } = scriptedServer([
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "api_diff", arguments: '{"package":"is-odd"}' },
              },
            ],
          },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "The bump looks safe based on api-diff." },
        },
      ],
    },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const executed: Array<{ name: string; input: Record<string, unknown> }> = [];
    const agentLoop = createOpenAiCompatibleAgentLoop({
      baseUrl,
      apiKey: "test-key",
      model: "glm-5.3-flash",
    });
    const result = await agentLoop.run({
      systemPrompt: "You are triaging a dependency bump.",
      userPrompt: "Investigate the bump.",
      tools: [fakeTool],
      executeTool: async (call) => {
        executed.push(call);
        return { text: '{"apiCompatible":true}', isError: false };
      },
    });

    assert.equal(result.report, "The bump looks safe based on api-diff.");
    assert.equal(result.turns, 2);
    assert.equal(executed.length, 1);
    assert.deepEqual(executed[0], { name: "api_diff", input: { package: "is-odd" } });
    assert.equal(result.toolCalls.length, 1);
    assert.equal(result.toolCalls[0]!.result, '{"apiCompatible":true}');

    // Second request carries a role:"tool" message keyed by tool_call_id — a
    // structurally different feedback shape from Anthropic's content blocks.
    const secondRequest = requestBodies[1] as {
      messages: Array<{ role: string; tool_call_id?: string; content?: string }>;
    };
    const toolMessage = secondRequest.messages.at(-1)!;
    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.tool_call_id, "call_1");
    assert.equal(toolMessage.content, '{"apiCompatible":true}');

    // First request declared the tool in OpenAI's nested function shape.
    const firstRequest = requestBodies[0] as {
      tools: Array<{ type: string; function: { name: string; parameters: unknown } }>;
    };
    assert.equal(firstRequest.tools[0]!.type, "function");
    assert.equal(firstRequest.tools[0]!.function.name, "api_diff");
    assert.ok(firstRequest.tools[0]!.function.parameters);
  });
});

test("createOpenAiCompatibleAgentLoop: no tool_calls on the first turn returns content immediately, zero tool calls", async () => {
  const { handler } = scriptedServer([
    {
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: "Nothing to check, skipping." } },
      ],
    },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createOpenAiCompatibleAgentLoop({ baseUrl, model: "glm-5.3-flash" });
    const result = await agentLoop.run({
      systemPrompt: "sys",
      userPrompt: "go",
      tools: [fakeTool],
      executeTool: async () => {
        throw new Error("should never be called");
      },
    });

    assert.equal(result.report, "Nothing to check, skipping.");
    assert.equal(result.turns, 1);
    assert.equal(result.toolCalls.length, 0);
  });
});

test("createOpenAiCompatibleAgentLoop: a tool execution that throws is logged as an error result, not thrown out of the loop", async () => {
  const { handler } = scriptedServer([
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "api_diff", arguments: '{"package":"is-odd"}' } },
            ],
          },
        },
      ],
    },
    {
      choices: [
        { finish_reason: "stop", message: { role: "assistant", content: "Tool failed, reporting as inconclusive." } },
      ],
    },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createOpenAiCompatibleAgentLoop({ baseUrl, model: "glm-5.3-flash" });
    const result = await agentLoop.run({
      systemPrompt: "sys",
      userPrompt: "go",
      tools: [fakeTool],
      executeTool: async () => {
        throw new Error("registry unreachable");
      },
    });

    assert.equal(result.report, "Tool failed, reporting as inconclusive.");
    assert.equal(result.toolCalls[0]!.isError, true);
    assert.match(result.toolCalls[0]!.result, /registry unreachable/);
  });
});

test("createOpenAiCompatibleAgentLoop: unparseable tool_call arguments is a hard error", async () => {
  const { handler } = scriptedServer([
    {
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            role: "assistant",
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "api_diff", arguments: "{not json" } },
            ],
          },
        },
      ],
    },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createOpenAiCompatibleAgentLoop({ baseUrl, model: "glm-5.3-flash" });
    await assert.rejects(
      () =>
        agentLoop.run({
          systemPrompt: "sys",
          userPrompt: "go",
          tools: [fakeTool],
          executeTool: async () => ({ text: "{}", isError: false }),
        }),
      /unparseable arguments/,
    );
  });
});

test("createOpenAiCompatibleAgentLoop: exceeding maxTurns while the model keeps requesting tool_calls is a hard error", async () => {
  const alwaysToolCalls = {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          tool_calls: [
            { id: "call_x", type: "function", function: { name: "api_diff", arguments: '{"package":"is-odd"}' } },
          ],
        },
      },
    ],
  };
  const { handler } = scriptedServer([alwaysToolCalls, alwaysToolCalls, alwaysToolCalls]);

  await withFakeServer(handler, async (baseUrl) => {
    const agentLoop = createOpenAiCompatibleAgentLoop({ baseUrl, model: "glm-5.3-flash" });
    await assert.rejects(
      () =>
        agentLoop.run({
          systemPrompt: "sys",
          userPrompt: "go",
          tools: [fakeTool],
          maxTurns: 3,
          executeTool: async () => ({ text: "{}", isError: false }),
        }),
      /exceeded maxTurns/,
    );
  });
});

test("createOpenAiCompatibleAgentLoop: non-2xx response is a hard error surfacing the status and body", async () => {
  await withFakeServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    },
    async (baseUrl) => {
      const agentLoop = createOpenAiCompatibleAgentLoop({ baseUrl, model: "glm-5.3-flash" });
      await assert.rejects(
        () =>
          agentLoop.run({
            systemPrompt: "sys",
            userPrompt: "go",
            tools: [fakeTool],
            executeTool: async () => ({ text: "{}", isError: false }),
          }),
        /OpenAI-compatible API error 500/,
      );
    },
  );
});

// --- Per-request timeout (protects against a genuinely stuck provider) ---

test("createAnthropicAgentLoop: a request that never responds times out — fails fast instead of hanging", async () => {
  await withFakeServer(
    (_req, _res) => {
      // Deliberately never call res.end() — simulates a provider that
      // accepted the connection but never responds.
    },
    async (baseUrl) => {
      const agentLoop = createAnthropicAgentLoop({ apiKey: "test-key", baseUrl, requestTimeoutMs: 200 });
      await assert.rejects(
        () =>
          agentLoop.run({
            systemPrompt: "sys",
            userPrompt: "go",
            tools: [fakeTool],
            executeTool: async () => ({ text: "{}", isError: false }),
          }),
        /Anthropic API request timed out after 200ms.*stuck/,
      );
    },
  );
});

test("createOpenAiCompatibleAgentLoop: a request that never responds times out — fails fast instead of hanging", async () => {
  await withFakeServer(
    (_req, _res) => {
      // Same simulated stuck provider as the Anthropic case above.
    },
    async (baseUrl) => {
      const agentLoop = createOpenAiCompatibleAgentLoop({ baseUrl, model: "glm-5.3-flash", requestTimeoutMs: 200 });
      await assert.rejects(
        () =>
          agentLoop.run({
            systemPrompt: "sys",
            userPrompt: "go",
            tools: [fakeTool],
            executeTool: async () => ({ text: "{}", isError: false }),
          }),
        /OpenAI-compatible API request timed out after 200ms.*stuck/,
      );
    },
  );
});
