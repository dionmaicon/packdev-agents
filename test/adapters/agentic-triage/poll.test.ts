import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, writeFile, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pollTriageOnce } from "../../../src/adapters/agentic-triage/poll.ts";
import { pollOnce } from "../../../src/adapters/selfhosted/poll.ts";
import { loadSeenState } from "../../../src/adapters/selfhosted/state.ts";
import { createAnthropicAgentLoop } from "../../../src/adapters/agentic-triage/agentLoop.ts";
import type { OpenBotPR, PullRequestSource } from "../../../src/providers/types.ts";
import type { ForgeOps, CommentInput, CheckRunInput } from "../../../src/core/pipeline.ts";

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

/** Same fixture shape as selfhosted/poll.test.ts's makeRemoteWithBumpPR — a real "main" + a real diverging bump branch. */
async function makeRemoteWithBumpPR(): Promise<{
  remoteDir: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}> {
  const remoteDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-remote-"));
  await git(remoteDir, ["init", "-q"]);
  await git(remoteDir, ["config", "user.email", "test@test.local"]);
  await git(remoteDir, ["config", "user.name", "test"]);
  await writeFile(
    path.join(remoteDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } }, null, 2),
  );
  await git(remoteDir, ["add", "-A"]);
  await git(remoteDir, ["commit", "-q", "-m", "base"]);
  await git(remoteDir, ["branch", "-M", "main"]);
  const baseSha = await git(remoteDir, ["rev-parse", "main"]);

  await git(remoteDir, ["checkout", "-q", "-b", "dependabot/bump"]);
  await writeFile(
    path.join(remoteDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } }, null, 2),
  );
  await git(remoteDir, ["add", "-A"]);
  await git(remoteDir, ["commit", "-q", "-m", "bump is-odd"]);
  const headSha = await git(remoteDir, ["rev-parse", "dependabot/bump"]);
  await git(remoteDir, ["checkout", "-q", "main"]);

  return { remoteDir, baseSha, headSha, cleanup: () => rm(remoteDir, { recursive: true, force: true }) };
}

function fakePRSource(prs: OpenBotPR[]): PullRequestSource {
  return { async listOpenBotPRs() { return prs; } };
}

function fakeForgeOps(): ForgeOps & { comments: CommentInput[]; checkRuns: CheckRunInput[]; mergeCalls: number } {
  const comments: CommentInput[] = [];
  const checkRuns: CheckRunInput[] = [];
  let mergeCalls = 0;
  return {
    comments,
    checkRuns,
    get mergeCalls() { return mergeCalls; },
    async upsertComment(input) { comments.push(input); },
    async createCheckRun(input) { checkRuns.push(input); },
    async mergePullRequest() { mergeCalls++; },
  };
}

/** Same pattern as agentic-triage/pipeline.test.ts: a fake Anthropic API that ends the turn immediately, so a real `packdev mcp` spawns but never needs a real tool round trip — keeps these tests fast and offline. */
async function withFakeAnthropicServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      void raw;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: "triage done" }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test(
  "pollTriageOnce: processes a new bot PR, posts an advisory comment, and records it in its own state",
  { timeout: 120_000 },
  async () => {
    await withFakeAnthropicServer(async (baseUrl) => {
      const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
      const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-clone-"));
      const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-state-"));
      try {
        const statePath = path.join(stateDir, "triage-state.json");
        const pr: OpenBotPR = { number: 7, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump", headSha };
        const forge = fakeForgeOps();

        const result = await pollTriageOnce({
          cloneDir,
          remoteUrl: remoteDir,
          statePath,
          prSource: fakePRSource([pr]),
          forgeOpsFor: () => forge,
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        assert.equal(result.processed.length, 1);
        assert.equal(result.skippedAlreadySeen.length, 0);
        assert.equal(result.processed[0]!.result.status, "triaged");
        assert.equal(forge.comments.length, 1);

        const state = await loadSeenState(statePath);
        assert.equal(state["7"], headSha);
      } finally {
        await cleanupRemote();
        await rm(cloneDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);

test(
  "pollTriageOnce: a PR already processed at its current head SHA is skipped, no forge calls",
  { timeout: 120_000 },
  async () => {
    await withFakeAnthropicServer(async (baseUrl) => {
      const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
      const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-clone-"));
      const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-state-"));
      try {
        const statePath = path.join(stateDir, "triage-state.json");
        const pr: OpenBotPR = { number: 7, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump", headSha };

        await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath,
          prSource: fakePRSource([pr]), forgeOpsFor: () => fakeForgeOps(),
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        const second = fakeForgeOps();
        const result = await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath,
          prSource: fakePRSource([pr]), forgeOpsFor: () => second,
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        assert.equal(result.processed.length, 0);
        assert.equal(result.skippedAlreadySeen.length, 1);
        assert.equal(second.comments.length, 0);
      } finally {
        await cleanupRemote();
        await rm(cloneDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);

test(
  "pollTriageOnce: a PR that picked up a new commit (new head SHA) is reprocessed, not skipped",
  { timeout: 120_000 },
  async () => {
    await withFakeAnthropicServer(async (baseUrl) => {
      const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
      const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-clone-"));
      const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-state-"));
      try {
        const statePath = path.join(stateDir, "triage-state.json");
        const pr: OpenBotPR = { number: 7, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump", headSha };

        await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath,
          prSource: fakePRSource([pr]), forgeOpsFor: () => fakeForgeOps(),
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        // A new commit lands on the bump branch between polls.
        await git(remoteDir, ["checkout", "-q", "dependabot/bump"]);
        await writeFile(
          path.join(remoteDir, "package.json"),
          JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1", commander: "11.1.0" } }, null, 2),
        );
        await git(remoteDir, ["add", "-A"]);
        await git(remoteDir, ["commit", "-q", "-m", "also bump commander"]);
        const newHeadSha = await git(remoteDir, ["rev-parse", "dependabot/bump"]);
        await git(remoteDir, ["checkout", "-q", "main"]);

        const movedPr: OpenBotPR = { ...pr, headSha: newHeadSha };
        const forge = fakeForgeOps();
        const result = await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath,
          prSource: fakePRSource([movedPr]), forgeOpsFor: () => forge,
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        assert.equal(result.processed.length, 1);
        assert.equal(result.skippedAlreadySeen.length, 0);
        const state = await loadSeenState(statePath);
        assert.equal(state["7"], newHeadSha);
      } finally {
        await cleanupRemote();
        await rm(cloneDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);

test(
  "pollTriageOnce: uses its OWN state file, fully independent from the compat pipeline's — processing a PR through one never marks it seen for the other",
  { timeout: 120_000 },
  async () => {
    await withFakeAnthropicServer(async (baseUrl) => {
      const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
      const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-clone-"));
      const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-state-"));
      try {
        const compatStatePath = path.join(stateDir, "compat-state.json");
        const triageStatePath = path.join(stateDir, "triage-state.json");
        const pr: OpenBotPR = { number: 7, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump", headSha };

        const compatResult = await pollOnce({
          cloneDir, remoteUrl: remoteDir, statePath: compatStatePath,
          testCommand: "true",
          prSource: fakePRSource([pr]), forgeOpsFor: () => fakeForgeOps(),
        });
        assert.equal(compatResult.processed.length, 1);

        // The triage state file has never been touched — this PR must NOT be skipped.
        const triageForge = fakeForgeOps();
        const triageResult = await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath: triageStatePath,
          prSource: fakePRSource([pr]), forgeOpsFor: () => triageForge,
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        assert.equal(triageResult.processed.length, 1);
        assert.equal(triageResult.skippedAlreadySeen.length, 0);
        assert.equal(triageForge.comments.length, 1);

        const compatState = await loadSeenState(compatStatePath);
        const triageState = await loadSeenState(triageStatePath);
        assert.equal(compatState["7"], headSha);
        assert.equal(triageState["7"], headSha);
      } finally {
        await cleanupRemote();
        await rm(cloneDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);

test(
  "pollTriageOnce: a save failure keeps the PR out of `processed` and its state unchanged, so it's retried next cycle",
  { timeout: 120_000 },
  async () => {
    await withFakeAnthropicServer(async (baseUrl) => {
      const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
      const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-clone-"));
      const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-state-"));
      try {
        const statePath = path.join(stateDir, "triage-state.json");
        const pr: OpenBotPR = { number: 7, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump", headSha };

        await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath,
          prSource: fakePRSource([pr]), forgeOpsFor: () => fakeForgeOps(),
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        await git(remoteDir, ["checkout", "-q", "-b", "dependabot/bump-2"]);
        await writeFile(
          path.join(remoteDir, "package.json"),
          JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.0", commander: "11.1.0" } }, null, 2),
        );
        await git(remoteDir, ["add", "-A"]);
        await git(remoteDir, ["commit", "-q", "-m", "bump commander"]);
        const secondHeadSha = await git(remoteDir, ["rev-parse", "dependabot/bump-2"]);
        await git(remoteDir, ["checkout", "-q", "main"]);

        const secondPr: OpenBotPR = { number: 8, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump-2", headSha: secondHeadSha };

        await chmod(statePath, 0o444);
        let result;
        try {
          result = await pollTriageOnce({
            cloneDir, remoteUrl: remoteDir, statePath,
            prSource: fakePRSource([secondPr]), forgeOpsFor: () => fakeForgeOps(),
            agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
          });
        } finally {
          await chmod(statePath, 0o644);
        }

        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0]!.pr.number, 8);
        assert.equal(result.processed.length, 0);

        const state = await loadSeenState(statePath);
        assert.deepEqual(state, { "7": headSha });
      } finally {
        await cleanupRemote();
        await rm(cloneDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);

test(
  "pollTriageOnce: one PR failing (bad branch) does not block a later, valid PR in the same cycle",
  { timeout: 120_000 },
  async () => {
    await withFakeAnthropicServer(async (baseUrl) => {
      const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
      const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-clone-"));
      const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-triage-poll-state-"));
      try {
        const statePath = path.join(stateDir, "triage-state.json");
        const brokenPr: OpenBotPR = {
          number: 1,
          actor: "dependabot[bot]",
          baseBranch: "main",
          baseSha,
          headBranch: "branch-that-does-not-exist",
          headSha: "0000000000000000000000000000000000000000",
        };
        const goodPr: OpenBotPR = { number: 7, actor: "dependabot[bot]", baseBranch: "main", baseSha, headBranch: "dependabot/bump", headSha };
        const forge = fakeForgeOps();

        const result = await pollTriageOnce({
          cloneDir, remoteUrl: remoteDir, statePath,
          prSource: fakePRSource([brokenPr, goodPr]), forgeOpsFor: () => forge,
          agentLoop: createAnthropicAgentLoop({ apiKey: "test", baseUrl }),
        });

        assert.equal(result.failed.length, 1);
        assert.equal(result.failed[0]!.pr.number, 1);
        assert.equal(result.processed.length, 1);
        assert.equal(result.processed[0]!.pr.number, 7);

        const state = await loadSeenState(statePath);
        assert.deepEqual(state, { "7": headSha });
      } finally {
        await cleanupRemote();
        await rm(cloneDir, { recursive: true, force: true });
        await rm(stateDir, { recursive: true, force: true });
      }
    });
  },
);
