import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runAgenticTriage } from "../../../src/adapters/agentic-triage/triage.ts";
import type { Bump } from "../../../src/core/extractBump.ts";

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

test(
  "runAgenticTriage: full chain — real packdev mcp server + a scripted model that calls api_diff for real, then reports",
  { timeout: 60_000 },
  async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-e2e-"));
    try {
      await mkdir(path.join(appDir, "src"), { recursive: true });
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          { name: "triage-e2e-fixture", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      // Real, deterministic confident-negative fixture — same one runApiDiff.test.ts
      // and pipeline.test.ts's static-incompatible test rely on: is-odd never had
      // a named "isOdd" export at any 3.x version.
      await writeFile(
        path.join(appDir, "src", "index.js"),
        'const { isOdd } = require("is-odd");\nisOdd(3);\n',
      );

      const bump: Bump = {
        name: "is-odd",
        fromVersion: "3.0.0",
        toVersion: "3.0.1",
        section: "dependencies",
        packageJsonPath: "package.json",
      };

      let call = 0;
      const handler = (
        req: import("node:http").IncomingMessage,
        res: import("node:http").ServerResponse,
      ) => {
        let raw = "";
        req.on("data", (chunk) => (raw += chunk));
        req.on("end", () => {
          const body = JSON.parse(raw) as { tools?: Array<{ name: string }> };
          call++;
          if (call === 1) {
            // Sanity: the real tool list from packdev mcp reached the model call.
            const names = (body.tools ?? []).map((t) => t.name);
            if (!names.includes("api_diff") || !names.includes("compat")) {
              res.writeHead(500);
              res.end(JSON.stringify({ error: "expected real packdev tools, got " + names.join(",") }));
              return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                stop_reason: "tool_use",
                content: [
                  {
                    type: "tool_use",
                    id: "call_1",
                    name: "api_diff",
                    input: { package: "is-odd", range: "3.0.1" },
                  },
                ],
              }),
            );
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              stop_reason: "end_turn",
              content: [{ type: "text", text: "api_diff found a missing export. Not safe to merge." }],
            }),
          );
        });
      };

      await withFakeServer(handler, async (baseUrl) => {
        const result = await runAgenticTriage({
          appDir,
          bump,
          apiKey: "test-key",
          baseUrl,
        });

        assert.equal(result.report, "api_diff found a missing export. Not safe to merge.");
        assert.equal(result.toolCalls.length, 1);
        assert.equal(result.toolCalls[0]!.name, "api_diff");
        assert.equal(result.toolCalls[0]!.isError, false);

        // The tool_result fed back to the model must be packdev's REAL report,
        // not a stub — confirms the MCP call actually ran, not just the loop.
        const realReport = JSON.parse(result.toolCalls[0]!.result) as {
          versions: Array<{ apiCompatible: boolean | null; missingSymbols: string[] }>;
        };
        assert.equal(realReport.versions[0]!.apiCompatible, false);
        assert.deepEqual(realReport.versions[0]!.missingSymbols, ["isOdd"]);
      });
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);
