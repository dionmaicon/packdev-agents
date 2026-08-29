import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { runAgentLoop, type AgentTool } from "../../../src/adapters/agentic-triage/agentLoop.ts";

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

test("runAgentLoop: single tool_use turn then a final text response — executes the tool, feeds the result back, returns the report", async () => {
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
    const result = await runAgentLoop({
      apiKey: "test-key",
      baseUrl,
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

test("runAgentLoop: no tool_use on the first turn returns the text immediately, zero tool calls", async () => {
  const { handler } = scriptedServer([
    { stop_reason: "end_turn", content: [{ type: "text", text: "Nothing to check, skipping." }] },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const result = await runAgentLoop({
      apiKey: "test-key",
      baseUrl,
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

test("runAgentLoop: a tool execution that throws is logged as an error result and fed back, not thrown out of the loop", async () => {
  const { handler } = scriptedServer([
    {
      stop_reason: "tool_use",
      content: [{ type: "tool_use", id: "call_1", name: "api_diff", input: { package: "is-odd" } }],
    },
    { stop_reason: "end_turn", content: [{ type: "text", text: "Tool failed, reporting as inconclusive." }] },
  ]);

  await withFakeServer(handler, async (baseUrl) => {
    const result = await runAgentLoop({
      apiKey: "test-key",
      baseUrl,
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

test("runAgentLoop: exceeding maxTurns while the model keeps asking for tools is a hard error", async () => {
  const alwaysToolUse = {
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "call_x", name: "api_diff", input: { package: "is-odd" } }],
  };
  const { handler } = scriptedServer([alwaysToolUse, alwaysToolUse, alwaysToolUse]);

  await withFakeServer(handler, async (baseUrl) => {
    await assert.rejects(
      () =>
        runAgentLoop({
          apiKey: "test-key",
          baseUrl,
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

test("runAgentLoop: non-2xx response is a hard error surfacing the status and body", async () => {
  await withFakeServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal" }));
    },
    async (baseUrl) => {
      await assert.rejects(
        () =>
          runAgentLoop({
            apiKey: "test-key",
            baseUrl,
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
