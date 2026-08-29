import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  runGithubPipeline,
  type GitHubOps,
  type CommentInput,
  type CheckRunInput,
} from "../../src/core/pipeline.ts";

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function makeRepo(
  baseDeps: Record<string, string>,
  headDeps: Record<string, string>,
): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-pipeline-"));
  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@test.local"]);
  await git(repoDir, ["config", "user.name", "test"]);
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

function fakeGitHubOps(): GitHubOps & {
  comments: CommentInput[];
  checkRuns: CheckRunInput[];
  mergeCalls: number;
} {
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

test("runGithubPipeline: actor not in allowedActors -> skipped-actor, zero GitHub calls", async () => {
  const { repoDir, cleanup } = await makeRepo(
    { "is-odd": "3.0.0" },
    { "is-odd": "3.0.1" },
  );
  try {
    const github = fakeGitHubOps();
    const result = await runGithubPipeline({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
      actor: "some-random-human",
      testCommand: "true",
      github,
    });

    assert.equal(result.status, "skipped-actor");
    assert.equal(github.comments.length, 0);
    assert.equal(github.checkRuns.length, 0);
  } finally {
    await cleanup();
  }
});

test("runGithubPipeline: grouped bump -> unsupported-bump, posts a comment + neutral check run, no compat run attempted", async () => {
  const { repoDir, cleanup } = await makeRepo(
    { "is-odd": "3.0.0", "is-number": "6.0.0" },
    { "is-odd": "3.0.1", "is-number": "7.0.0" },
  );
  try {
    const github = fakeGitHubOps();
    const result = await runGithubPipeline({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
      actor: "dependabot[bot]",
      testCommand: "true",
      github,
    });

    assert.equal(result.status, "unsupported-bump");
    assert.equal(github.comments.length, 1);
    assert.match(github.comments[0]!.body, /Grouped update/);
    assert.equal(github.checkRuns.length, 1);
    assert.equal(github.checkRuns[0]!.conclusion, "neutral");
  } finally {
    await cleanup();
  }
});

test(
  "runGithubPipeline: single bump, PASSED, autoMerge off by default -> success check, no merge call",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
    );
    try {
      const github = fakeGitHubOps();
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand:
          'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
        github,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.verdict.kind, "PASSED");
        assert.equal(result.merged, false);
      }
      assert.equal(github.checkRuns[0]!.conclusion, "success");
      assert.equal(github.mergeCalls, 0, "autoMerge defaults to off");
      assert.equal(
        github.comments[0]!.body.startsWith("<!-- packdev-agents:compat-check -->"),
        true,
      );
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: single bump, PASSED, autoMerge on -> merges exactly once",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
    );
    try {
      const github = fakeGitHubOps();
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand:
          'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
        github,
        autoMerge: true,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.merged, true);
      }
      assert.equal(github.mergeCalls, 1);
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: candidate genuinely incompatible -> failure check, never merges even with autoMerge on",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
    );
    try {
      const github = fakeGitHubOps();
      // Inverted assertion: is-odd(4) actually IS false, so asserting it's
      // true makes this test command fail against BOTH control and
      // candidate — but since we need the candidate specifically to differ
      // from control for a real INCOMPATIBLE (not HARNESS_BROKEN), use a
      // command that only fails on the exact candidate version string.
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand:
          'node -e "const v=require(\'is-odd/package.json\').version; if (v === \'3.0.1\') process.exit(1)"',
        github,
        autoMerge: true,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.verdict.kind, "INCOMPATIBLE");
        assert.equal(result.merged, false);
      }
      assert.equal(github.checkRuns[0]!.conclusion, "failure");
      assert.equal(github.mergeCalls, 0);
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: cleans up its workspace temp dir after a normal run",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
    );
    // prepareWorkspace's mkdtemp resolves os.tmpdir() dynamically from
    // TMPDIR at call time — pointing it at a private, empty directory for
    // the duration of this test makes the "did it clean up?" assertion
    // immune to other test FILES racing on the shared OS temp dir (node's
    // test runner runs files concurrently by default; a shared-prefix scan
    // there is inherently flaky, not a signal about this code).
    const isolatedTmp = await mkdtemp(path.join(tmpdir(), "packdev-agents-isolated-tmp-"));
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = isolatedTmp;
    try {
      const github = fakeGitHubOps();
      await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand: "true",
        github,
      });
      // packdev's own compat run legitimately leaves a lockfile snapshot
      // dir behind under the same TMPDIR (by design — reproducibility
      // auditing, not something we asked it to clean up), so only assert
      // on OUR prefix rather than demanding the whole isolated dir be empty.
      const entries = await readdir(isolatedTmp);
      const workspaceDirs = entries.filter((name) =>
        name.startsWith("packdev-agents-workspace-"),
      );
      assert.deepEqual(
        workspaceDirs,
        [],
        "prepareWorkspace's own temp dir must be removed after the run",
      );
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
      await cleanup();
      await rm(isolatedTmp, { recursive: true, force: true });
    }
  },
);

test(
  "runGithubPipeline: test command broken for reasons unrelated to the bump -> HARNESS_BROKEN, never blames the bump",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
    );
    try {
      const github = fakeGitHubOps();
      // Fails identically for control AND candidate — a broken harness,
      // not a real incompatibility signal from either version.
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand: 'node -e "require(\'this-module-does-not-exist-xyz\')"',
        github,
        autoMerge: true,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.verdict.kind, "HARNESS_BROKEN");
        assert.equal(result.merged, false);
      }
      assert.equal(github.checkRuns[0]!.conclusion, "failure");
      assert.equal(github.mergeCalls, 0, "must never merge on a broken harness, even with autoMerge on");
      assert.match(github.comments[0]!.body, /test harness itself is broken/);
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: passing candidate with a type-check-only test command -> PASSED_WEAK, not auto-merge eligible",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
    );
    try {
      // package.json needs to declare typescript for `npx tsc` to resolve
      // inside packdev's sandbox, and tsc needs at least one input file to
      // exit 0 (`tsc --noEmit` with zero matched files is TS18003, a
      // genuine error) — amend the base commit's tree via a new commit on
      // "base" so both control and candidate sandboxes have both.
      await execFileAsync("git", ["checkout", "-q", "base"], { cwd: repoDir });
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "fixture-app",
            version: "1.0.0",
            dependencies: { "is-odd": "3.0.0" },
            devDependencies: { typescript: "^5.9.2" },
          },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(repoDir, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: false, skipLibCheck: true } }, null, 2),
      );
      await writeFile(path.join(repoDir, "index.ts"), "export const x: number = 1;\n");
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "add typescript"]);
      await git(repoDir, ["checkout", "-q", "master"]);
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          {
            name: "fixture-app",
            version: "1.0.0",
            dependencies: { "is-odd": "3.0.1" },
            devDependencies: { typescript: "^5.9.2" },
          },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump on top of typescript commit"]);

      const github = fakeGitHubOps();
      // A bare `tsc --noEmit` is packdev's TYPE_CHECK_ONLY trigger
      // (src/compat.ts's analyzeTestHarness) — matched on the command
      // string itself, independent of whether it actually passes.
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand: "npx tsc --noEmit",
        github,
        autoMerge: true,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.verdict.kind, "PASSED_WEAK");
        assert.equal(result.merged, false, "PASSED_WEAK must never auto-merge");
      }
      assert.equal(github.checkRuns[0]!.conclusion, "neutral");
      assert.equal(github.mergeCalls, 0);
      assert.match(github.comments[0]!.body, /TYPE_CHECK_ONLY/);
    } finally {
      await cleanup();
    }
  },
);
