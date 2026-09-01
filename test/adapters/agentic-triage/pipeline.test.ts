import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runAgenticTriagePipeline,
  AGENTIC_TRIAGE_COMMENT_MARKER,
} from "../../../src/adapters/agentic-triage/pipeline.ts";
import { createAnthropicAgentLoop, type AgentLoop } from "../../../src/adapters/agentic-triage/agentLoop.ts";
import type {
  ForgeOps,
  CommentInput,
  CheckRunInput,
} from "../../../src/core/pipeline.ts";

/** For tests where the agent loop must never actually be invoked (actor gate, unsupported bump). */
const neverCalledAgentLoop: AgentLoop = {
  run: async () => {
    throw new Error("agent loop should never be called");
  },
};

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}

async function makeRepoWithUsage(
  baseDeps: Record<string, string>,
  headDeps: Record<string, string>,
  sourceContent: string,
): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-pipeline-"));
  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@test.local"]);
  await git(repoDir, ["config", "user.name", "test"]);
  await mkdir(path.join(repoDir, "src"), { recursive: true });
  await writeFile(path.join(repoDir, "src", "index.js"), sourceContent);
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: baseDeps }, null, 2),
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "base"]);
  await git(repoDir, ["branch", "base"]);

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: headDeps }, null, 2),
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "bump"]);

  return { repoDir, cleanup: () => rm(repoDir, { recursive: true, force: true }) };
}

function fakeGitHubOps(): ForgeOps & { comments: CommentInput[]; checkRuns: CheckRunInput[]; mergeCalls: number } {
  const comments: CommentInput[] = [];
  const checkRuns: CheckRunInput[] = [];
  let mergeCalls = 0;
  return {
    comments,
    checkRuns,
    get mergeCalls() {
      return mergeCalls;
    },
    async upsertComment(input) {
      comments.push(input);
    },
    async createCheckRun(input) {
      checkRuns.push(input);
    },
    async mergePullRequest() {
      mergeCalls++;
    },
  };
}

async function withFakeAnthropicServer(
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

function singleTurnReport(text: string) {
  let call = 0;
  return (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      call++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text }] }));
      void call;
    });
  };
}

test("runAgenticTriagePipeline: actor not allowed -> skipped-actor, zero GitHub calls", async () => {
  const { repoDir, cleanup } = await makeRepoWithUsage(
    { "is-odd": "3.0.0" },
    { "is-odd": "3.0.1" },
    'require("is-odd");\n',
  );
  try {
    const github = fakeGitHubOps();
    const result = await runAgenticTriagePipeline({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
      actor: "some-random-human",
      forge: github,
      agentLoop: neverCalledAgentLoop,
    });

    assert.equal(result.status, "skipped-actor");
    assert.equal(github.comments.length, 0);
    assert.equal(github.checkRuns.length, 0);
  } finally {
    await cleanup();
  }
});

test("runAgenticTriagePipeline: grouped bump -> unsupported-bump, no MCP/model call attempted", async () => {
  const { repoDir, cleanup } = await makeRepoWithUsage(
    { "is-odd": "3.0.0", "is-number": "6.0.0" },
    { "is-odd": "3.0.1", "is-number": "7.0.0" },
    'require("is-odd");\n',
  );
  try {
    const github = fakeGitHubOps();
    const result = await runAgenticTriagePipeline({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
      actor: "dependabot[bot]",
      forge: github,
      agentLoop: neverCalledAgentLoop,
    });

    assert.equal(result.status, "unsupported-bump");
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0]!.body, new RegExp(AGENTIC_TRIAGE_COMMENT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(github.checkRuns.length, 0);
  } finally {
    await cleanup();
  }
});

test(
  "runAgenticTriagePipeline: single bump -> posts an advisory comment + neutral check run, never merges",
  { timeout: 60_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepoWithUsage(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
      'const { isOdd } = require("is-odd");\nisOdd(3);\n',
    );
    try {
      await withFakeAnthropicServer(
        singleTurnReport("Looks safe based on a quick static check."),
        async (baseUrl) => {
          const github = fakeGitHubOps();
          const result = await runAgenticTriagePipeline({
            repoDir,
            baseRef: "base",
            headRef: "HEAD",
            actor: "dependabot[bot]",
            forge: github,
            agentLoop: createAnthropicAgentLoop({ apiKey: "test-key", baseUrl }),
          });

          assert.equal(result.status, "triaged");
          if (result.status === "triaged") {
            assert.equal(result.bump.name, "is-odd");
            assert.equal(result.triage.report, "Looks safe based on a quick static check.");
          }

          assert.equal(github.comments.length, 1);
          assert.match(github.comments[0]!.body, /Agentic triage/);
          assert.match(github.comments[0]!.body, /Looks safe based on a quick static check\./);
          assert.match(github.comments[0]!.body, /advisory only/);

          assert.equal(github.checkRuns.length, 1);
          assert.equal(github.checkRuns[0]!.conclusion, "neutral");
          assert.equal(github.checkRuns[0]!.name, "packdev agentic triage");

          // Advisory only — must never touch merge, unlike core/pipeline.ts.
          assert.equal(github.mergeCalls, 0);
        },
      );
    } finally {
      await cleanup();
    }
  },
);
