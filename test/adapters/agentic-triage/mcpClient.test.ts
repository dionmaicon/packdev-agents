import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { connectPackdevMcp } from "../../../src/adapters/agentic-triage/mcpClient.ts";

test(
  "connectPackdevMcp: real end-to-end against the actual packdev mcp server — lists tools, calls api_diff",
  { timeout: 60_000 },
  async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-mcp-e2e-"));
    try {
      await mkdir(path.join(appDir, "src"), { recursive: true });
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          { name: "mcp-e2e-fixture", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(appDir, "src", "index.js"),
        'const { isOdd } = require("is-odd");\nisOdd(3);\n',
      );

      const session = await connectPackdevMcp({ cwd: appDir });
      try {
        const tools = await session.listTools();
        const names = tools.map((t) => t.name);
        assert.ok(names.includes("api_diff"));
        assert.ok(names.includes("compat"));
        assert.ok(names.includes("dupes"));

        const apiDiffTool = tools.find((t) => t.name === "api_diff")!;
        assert.equal(apiDiffTool.inputSchema["type"], "object");
        assert.ok((apiDiffTool.inputSchema["required"] as string[]).includes("package"));

        const result = await session.callTool("api_diff", {
          package: "is-odd",
          range: "3.0.1",
        });
        assert.equal(result.isError, false);
        const report = JSON.parse(result.text) as { versions: Array<{ apiCompatible: boolean | null }> };
        assert.equal(report.versions[0]!.apiCompatible, false);
      } finally {
        await session.close();
      }
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);

test(
  "connectPackdevMcp: real end-to-end — dupes tool runs cleanly against a real install",
  { timeout: 60_000 },
  async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-mcp-dupes-"));
    try {
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          { name: "mcp-dupes-fixture", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir });

      const session = await connectPackdevMcp({ cwd: appDir });
      try {
        const result = await session.callTool("dupes", { package: "is-odd" });
        assert.equal(result.isError, false);
        const report = JSON.parse(result.text) as { package: string };
        assert.equal(report.package, "is-odd");
      } finally {
        await session.close();
      }
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);
