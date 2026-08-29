import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pollOnce } from "../../../src/adapters/selfhosted/poll.ts";
import { loadSeenState } from "../../../src/adapters/selfhosted/state.ts";
import type {
  OpenBotPR,
  PullRequestSource,
} from "../../../src/adapters/selfhosted/discoverPRs.ts";
import type {
  GitHubOps,
  CommentInput,
  CheckRunInput,
} from "../../../src/core/pipeline.ts";

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

/**
 * Builds a fake "remote" repo shaped like a real Dependabot PR: a "main"
 * branch declaring is-odd@3.0.0, and a "dependabot/bump" branch that
 * diverges from it with is-odd bumped to 3.0.1 — same structure poll.ts
 * will actually encounter against a real GitHub repo, just over a local
 * git remote (a plain file path) instead of the GitHub API.
 */
async function makeRemoteWithBumpPR(): Promise<{
  remoteDir: string;
  baseSha: string;
  headSha: string;
  cleanup: () => Promise<void>;
}> {
  const remoteDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-remote-"));
  await git(remoteDir, ["init", "-q"]);
  await git(remoteDir, ["config", "user.email", "test@test.local"]);
  await git(remoteDir, ["config", "user.name", "test"]);
  await writeFile(
    path.join(remoteDir, "package.json"),
    JSON.stringify(
      { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
      null,
      2,
    ),
  );
  await git(remoteDir, ["add", "-A"]);
  await git(remoteDir, ["commit", "-q", "-m", "base"]);
  await git(remoteDir, ["branch", "-M", "main"]);
  const baseSha = await git(remoteDir, ["rev-parse", "main"]);

  await git(remoteDir, ["checkout", "-q", "-b", "dependabot/bump"]);
  await writeFile(
    path.join(remoteDir, "package.json"),
    JSON.stringify(
      { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
      null,
      2,
    ),
  );
  await git(remoteDir, ["add", "-A"]);
  await git(remoteDir, ["commit", "-q", "-m", "bump is-odd"]);
  const headSha = await git(remoteDir, ["rev-parse", "dependabot/bump"]);
  await git(remoteDir, ["checkout", "-q", "main"]);

  return {
    remoteDir,
    baseSha,
    headSha,
    cleanup: () => rm(remoteDir, { recursive: true, force: true }),
  };
}

function fakePRSource(prs: OpenBotPR[]): PullRequestSource {
  return { async listOpenBotPRs() { return prs; } };
}

function fakeGitHubOps(): GitHubOps & { comments: CommentInput[]; checkRuns: CheckRunInput[]; mergeCalls: number } {
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

test(
  "pollOnce: processes a new bot PR, posts a comment/check, and records it in state",
  { timeout: 120_000 },
  async () => {
    const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
    const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-clone-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-state-"));
    try {
      const statePath = path.join(stateDir, "state.json");
      const pr: OpenBotPR = {
        number: 7,
        actor: "dependabot[bot]",
        baseBranch: "main",
        baseSha,
        headBranch: "dependabot/bump",
        headSha,
      };
      const github = fakeGitHubOps();

      const result = await pollOnce({
        cloneDir,
        remoteUrl: remoteDir,
        statePath,
        testCommand:
          'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
        prSource: fakePRSource([pr]),
        githubOpsFor: () => github,
      });

      assert.equal(result.processed.length, 1);
      assert.equal(result.skippedAlreadySeen.length, 0);
      const processedResult = result.processed[0]!.result;
      assert.equal(processedResult.status, "verdict");
      if (processedResult.status === "verdict") {
        assert.equal(processedResult.verdict.kind, "PASSED");
      }
      assert.equal(github.comments.length, 1);
      assert.equal(github.checkRuns.length, 1);

      const state = await loadSeenState(statePath);
      assert.equal(state["7"], headSha);
    } finally {
      await cleanupRemote();
      await rm(cloneDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "pollOnce: a PR already processed at its current head SHA is skipped, no GitHub calls",
  { timeout: 120_000 },
  async () => {
    const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
    const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-clone-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-state-"));
    try {
      const statePath = path.join(stateDir, "state.json");
      const pr: OpenBotPR = {
        number: 7,
        actor: "dependabot[bot]",
        baseBranch: "main",
        baseSha,
        headBranch: "dependabot/bump",
        headSha,
      };

      const firstGithub = fakeGitHubOps();
      await pollOnce({
        cloneDir,
        remoteUrl: remoteDir,
        statePath,
        testCommand: "true",
        prSource: fakePRSource([pr]),
        githubOpsFor: () => firstGithub,
      });

      const secondGithub = fakeGitHubOps();
      const result = await pollOnce({
        cloneDir,
        remoteUrl: remoteDir,
        statePath,
        testCommand: "true",
        prSource: fakePRSource([pr]),
        githubOpsFor: () => secondGithub,
      });

      assert.equal(result.processed.length, 0);
      assert.equal(result.skippedAlreadySeen.length, 1);
      assert.equal(secondGithub.comments.length, 0);
      assert.equal(secondGithub.checkRuns.length, 0);
    } finally {
      await cleanupRemote();
      await rm(cloneDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "pollOnce: a PR that picked up a new commit (new head SHA) is reprocessed, not skipped",
  { timeout: 120_000 },
  async () => {
    const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
    const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-clone-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-state-"));
    try {
      const statePath = path.join(stateDir, "state.json");
      const pr: OpenBotPR = {
        number: 7,
        actor: "dependabot[bot]",
        baseBranch: "main",
        baseSha,
        headBranch: "dependabot/bump",
        headSha,
      };

      await pollOnce({
        cloneDir,
        remoteUrl: remoteDir,
        statePath,
        testCommand: "true",
        prSource: fakePRSource([pr]),
        githubOpsFor: () => fakeGitHubOps(),
      });

      // Simulate Dependabot rebasing/pushing a new commit to the same PR.
      await git(remoteDir, ["checkout", "-q", "dependabot/bump"]);
      await writeFile(path.join(remoteDir, "extra.txt"), "new commit");
      await git(remoteDir, ["add", "-A"]);
      await git(remoteDir, ["commit", "-q", "-m", "rebase"]);
      const newHeadSha = await git(remoteDir, ["rev-parse", "dependabot/bump"]);
      await git(remoteDir, ["checkout", "-q", "main"]);

      const updatedPr: OpenBotPR = { ...pr, headSha: newHeadSha };
      const github = fakeGitHubOps();
      const result = await pollOnce({
        cloneDir,
        remoteUrl: remoteDir,
        statePath,
        testCommand: "true",
        prSource: fakePRSource([updatedPr]),
        githubOpsFor: () => github,
      });

      assert.equal(result.processed.length, 1);
      assert.equal(github.comments.length, 1);
      const state = await loadSeenState(statePath);
      assert.equal(state["7"], newHeadSha);
    } finally {
      await cleanupRemote();
      await rm(cloneDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);

test(
  "pollOnce: actor not in allowedActors is filtered out entirely, no state entry written",
  { timeout: 120_000 },
  async () => {
    const { remoteDir, baseSha, headSha, cleanup: cleanupRemote } = await makeRemoteWithBumpPR();
    const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-clone-"));
    const stateDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-poll-state-"));
    try {
      const statePath = path.join(stateDir, "state.json");
      const pr: OpenBotPR = {
        number: 9,
        actor: "some-human",
        baseBranch: "main",
        baseSha,
        headBranch: "dependabot/bump",
        headSha,
      };
      const github = fakeGitHubOps();

      const result = await pollOnce({
        cloneDir,
        remoteUrl: remoteDir,
        statePath,
        testCommand: "true",
        prSource: fakePRSource([pr]),
        githubOpsFor: () => github,
      });

      assert.equal(result.processed.length, 0);
      assert.equal(result.skippedAlreadySeen.length, 0);
      assert.equal(github.comments.length, 0);
      const state = await loadSeenState(statePath);
      assert.deepEqual(state, {});
    } finally {
      await cleanupRemote();
      await rm(cloneDir, { recursive: true, force: true });
      await rm(stateDir, { recursive: true, force: true });
    }
  },
);
