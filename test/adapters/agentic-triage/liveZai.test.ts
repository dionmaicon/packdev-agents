import { test } from "node:test";
import { readFile, mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path, { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { runAgenticTriage } from "../../../src/adapters/agentic-triage/triage.ts";
import { createOpenAiCompatibleAgentLoop } from "../../../src/adapters/agentic-triage/agentLoop.ts";
import type { Bump } from "../../../src/core/extractBump.ts";

/**
 * A REAL live test against the real Z.ai API — not faked, unlike every
 * other test in this repo's usual style. Skipped entirely (not failed)
 * when no key is available, so this never breaks CI or a machine without
 * a Z.ai subscription; it exists to actually observe how a genuinely
 * different model family (GLM, not Claude) behaves in the same tool-use
 * loop, per the user's explicit request to test with a real model.
 */
async function readZaiApiKey(): Promise<string | undefined> {
  if (process.env["ZAI_API_KEY"]) return process.env["ZAI_API_KEY"];

  const repoRoot = path.resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  try {
    const envContents = await readFile(path.join(repoRoot, ".env"), "utf8");
    const match = envContents.match(/^ZAI_API_KEY=(.+)$/m);
    return match?.[1]?.trim();
  } catch {
    return undefined;
  }
}

const apiKey = await readZaiApiKey();

test(
  "runAgenticTriage: LIVE against the real Z.ai API (glm-5.3-flash) — real packdev mcp + a genuinely different model family",
  {
    // Observed real range across multiple live runs: ~90s (5-6 tool
    // calls) up to ~330s (7 tool calls, thorough investigation) — 300s
    // genuinely timed out once. 600s gives real headroom without masking
    // an actual hang (the agent loop's own maxTurns cap is the backstop
    // against a truly runaway loop, not this timeout).
    timeout: 600_000,
    skip: apiKey ? false : "ZAI_API_KEY not set (env or .env) — skipping live model test",
  },
  async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-live-zai-"));
    try {
      await mkdir(path.join(appDir, "src"), { recursive: true });
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          { name: "live-zai-fixture", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      // Same deterministic confident-negative fixture used throughout T13/T14:
      // is-odd never had a named "isOdd" export at any 3.x version — a real
      // model that runs api_diff should be able to notice this.
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

      const agentLoop = createOpenAiCompatibleAgentLoop({
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
        apiKey: apiKey!,
        model: "glm-5.3-flash",
        maxOutputTokens: 4000,
      });

      const result = await runAgenticTriage({
        appDir,
        bump,
        agentLoop,
        maxTurns: 8,
      });

      console.log("\n=== LIVE Z.ai (glm-5.3-flash) agentic triage ===");
      console.log(`Tool calls (${result.toolCalls.length}):`);
      for (const call of result.toolCalls) {
        console.log(`  - ${call.name}(${JSON.stringify(call.input)}) -> isError=${call.isError}`);
      }
      console.log("Report:\n" + result.report);
      console.log("=== end live output ===\n");

      // Loose assertions on purpose — this is a real model, not a script.
      // The point is observing real behavior, not pinning exact wording.
      assert.ok(result.report.trim().length > 0, "expected a non-empty final report");
      assert.ok(result.toolCalls.length > 0, "expected the model to call at least one real tool");
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);
