import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access, readdir, mkdir } from "node:fs/promises";
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

/**
 * A real npm-workspaces monorepo: root package.json declares "workspaces":
 * ["packages/*"], and the bumped dependency lives in packages/api's own
 * package.json — not the root's. Root has no "dependencies" of its own,
 * matching a typical real workspaces root.
 */
async function makeMonorepo(
  memberDeps: Record<string, string>,
  headMemberDeps: Record<string, string>,
): Promise<{ repoDir: string; packageJsonPath: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-monorepo-"));
  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@test.local"]);
  await git(repoDir, ["config", "user.name", "test"]);

  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(
      { name: "monorepo-root", version: "1.0.0", private: true, workspaces: ["packages/*"] },
      null,
      2,
    ),
  );
  await mkdir(path.join(repoDir, "packages", "api"), { recursive: true });
  await writeFile(
    path.join(repoDir, "packages", "api", "package.json"),
    JSON.stringify(
      { name: "@fixture/api", version: "1.0.0", dependencies: memberDeps },
      null,
      2,
    ),
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "base"]);
  await git(repoDir, ["branch", "base"]);

  await writeFile(
    path.join(repoDir, "packages", "api", "package.json"),
    JSON.stringify(
      { name: "@fixture/api", version: "1.0.0", dependencies: headMemberDeps },
      null,
      2,
    ),
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "bump"]);

  return {
    repoDir,
    packageJsonPath: "packages/api/package.json",
    cleanup: () => rm(repoDir, { recursive: true, force: true }),
  };
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

test(
  "runGithubPipeline: packageJsonPath targets a workspace member, not the monorepo root",
  { timeout: 120_000 },
  async () => {
    const { repoDir, packageJsonPath, cleanup } = await makeMonorepo(
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
        packageJsonPath,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        // Proves extractBump read the DIFF from packages/api's own
        // package.json, not the monorepo root's (which has no
        // "dependencies" at all — a diff against the root would have
        // found nothing and returned Unsupported instead).
        assert.equal(result.bump.name, "is-odd");
        assert.equal(result.bump.fromVersion, "3.0.0");
        assert.equal(result.bump.toVersion, "3.0.1");
        // Proves the compat sandbox actually ran from the workspace
        // member's directory and found a real control there (hoisted or
        // not) — a NO_CONTROL verdict here would mean it ran against the
        // wrong directory instead.
        assert.equal(result.verdict.kind, "PASSED");
      }
      assert.equal(github.checkRuns[0]!.conclusion, "success");
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: packageJsonPath — a genuinely incompatible bump in a workspace member is still caught",
  { timeout: 120_000 },
  async () => {
    const { repoDir, packageJsonPath, cleanup } = await makeMonorepo(
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
          'node -e "const v=require(\'is-odd/package.json\').version; if (v === \'3.0.1\') process.exit(1)"',
        github,
        packageJsonPath,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.verdict.kind, "INCOMPATIBLE");
      }
      assert.equal(github.checkRuns[0]!.conclusion, "failure");
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: NO packageJsonPath given — auto-discovers which workspace member changed, with two members present",
  { timeout: 120_000 },
  async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-monorepo2-"));
    try {
      await git(repoDir, ["init", "-q"]);
      await git(repoDir, ["config", "user.email", "test@test.local"]);
      await git(repoDir, ["config", "user.name", "test"]);

      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          { name: "monorepo-root", version: "1.0.0", private: true, workspaces: ["packages/*"] },
          null,
          2,
        ),
      );
      await mkdir(path.join(repoDir, "packages", "api"), { recursive: true });
      await mkdir(path.join(repoDir, "packages", "worker"), { recursive: true });
      await writeFile(
        path.join(repoDir, "packages", "api", "package.json"),
        JSON.stringify(
          { name: "@fixture/api", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(repoDir, "packages", "worker", "package.json"),
        JSON.stringify(
          { name: "@fixture/worker", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "base"]);
      await git(repoDir, ["branch", "base"]);

      // Only worker changes on this PR, matching Dependabot's per-directory
      // PRs — api is left untouched.
      await writeFile(
        path.join(repoDir, "packages", "worker", "package.json"),
        JSON.stringify(
          { name: "@fixture/worker", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump is-odd in worker only"]);

      const github = fakeGitHubOps();
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand:
          'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
        github,
        // No packageJsonPath — this is the point of the test.
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.bump.packageJsonPath, "packages/worker/package.json");
        assert.equal(result.verdict.kind, "PASSED");
      }
      assert.equal(github.checkRuns[0]!.conclusion, "success");
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  },
);

/**
 * A real repo whose app source actually imports the bumped package, needed
 * for the api-diff static pre-filter tests below — makeRepo() above only
 * ever writes a package.json, so packdev's static usage scan would find
 * nothing to check and vacuously fall through to compat every time.
 */
async function makeRepoWithUsage(
  baseDeps: Record<string, string>,
  headDeps: Record<string, string>,
  sourceContent: string,
): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-pipeline-apidiff-"));
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

test(
  "runGithubPipeline: a symbol missing at BOTH control and candidate is a pre-existing issue, NOT a bump regression — falls through to real compat instead of a false static-incompatible",
  { timeout: 60_000 },
  async () => {
    // Real bug, found live: is-odd never had a named "isOdd" export at ANY
    // 3.x version — control (3.0.0) is EQUALLY missing it, so this is not
    // something the 3.0.0 -> 3.0.1 bump introduced. Before the fix, this
    // exact fixture produced a false "the bump is incompatible with this
    // app" — the app was already broken, unrelated to the bump.
    // testCommand "true" never actually calls isOdd, so falling through to
    // the real compat run correctly PASSES: proof the short-circuit no
    // longer fires here, not a coincidence of a lenient test command.
    const { repoDir, cleanup } = await makeRepoWithUsage(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
      'const { isOdd } = require("is-odd");\nisOdd(3);\n',
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
        autoMerge: true,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        assert.equal(result.verdict.kind, "PASSED");
      }
      assert.equal(github.mergeCalls, 1);
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: dynamic (bare require) usage never short-circuits — always falls through to the real compat run",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepoWithUsage(
      { "is-odd": "3.0.0" },
      { "is-odd": "3.0.1" },
      'const isOdd = require("is-odd");\nisOdd(3);\n',
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
      }
    } finally {
      await cleanup();
    }
  },
);

test(
  "runGithubPipeline: grouped bump with the SAME target version — pins companions via --group, real PASSED verdict against a real @nestjs/* family bump",
  { timeout: 60_000 },
  async () => {
    const { repoDir, cleanup } = await makeRepo(
      {
        "@nestjs/core": "11.0.0",
        "@nestjs/common": "11.0.0",
        "@nestjs/platform-express": "11.0.0",
        "reflect-metadata": "^0.2.2",
        rxjs: "^7.8.2",
      },
      {
        "@nestjs/core": "11.2.3",
        "@nestjs/common": "11.2.3",
        "@nestjs/platform-express": "11.2.3",
        "reflect-metadata": "^0.2.2",
        rxjs: "^7.8.2",
      },
    );
    try {
      const github = fakeGitHubOps();
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand:
          'node -e "require(\'reflect-metadata\'); const { Module } = require(\'@nestjs/common\'); const { NestFactory } = require(\'@nestjs/core\'); if (typeof Module !== \'function\' || typeof NestFactory !== \'object\') process.exit(1)"',
        github,
      });

      assert.equal(result.status, "verdict");
      if (result.status === "verdict") {
        // Deterministic primary selection (sorted by name) — see extractBump.ts.
        assert.equal(result.bump.name, "@nestjs/common");
        assert.deepEqual(result.bump.group, ["@nestjs/core", "@nestjs/platform-express"]);
        assert.equal(result.verdict.kind, "PASSED");
        // Confirms packdev's own report carries the group back — this is
        // proof --group was actually passed and honored, not just that our
        // own bump-detection logic worked.
        assert.deepEqual(result.verdict.report.group, ["@nestjs/core", "@nestjs/platform-express"]);
      }

      assert.equal(github.comments.length, 1);
      assert.match(github.comments[0]!.body, /grouped with .@nestjs\/core., .@nestjs\/platform-express./);
      assert.equal(github.checkRuns[0]!.conclusion, "success");
    } finally {
      await cleanup();
    }
  },
);


test(
  "runGithubPipeline: cross-file bump — the SAME package bumped to the SAME version in two independent apps runs once per app and aggregates a real verdict",
  { timeout: 60_000 },
  async () => {
    const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-crossfile-"));
    try {
      await git(repoDir, ["init", "-q"]);
      await git(repoDir, ["config", "user.email", "test@test.local"]);
      await git(repoDir, ["config", "user.name", "test"]);
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify({ name: "monorepo-root", version: "1.0.0", private: true, workspaces: ["apps/*"] }, null, 2),
      );
      const nestDeps = (version: string) => ({
        "@nestjs/core": version,
        "reflect-metadata": "^0.2.2",
        rxjs: "^7.8.2",
      });
      for (const app of ["gateway", "notifier"]) {
        await mkdir(path.join(repoDir, "apps", app), { recursive: true });
        await writeFile(
          path.join(repoDir, "apps", app, "package.json"),
          JSON.stringify({ name: `@fixture/${app}`, version: "1.0.0", dependencies: nestDeps("11.0.0") }, null, 2),
        );
      }
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "base"]);
      await git(repoDir, ["branch", "base"]);

      for (const app of ["gateway", "notifier"]) {
        await writeFile(
          path.join(repoDir, "apps", app, "package.json"),
          JSON.stringify({ name: `@fixture/${app}`, version: "1.0.0", dependencies: nestDeps("11.2.3") }, null, 2),
        );
      }
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump @nestjs/core in both apps"]);

      const github = fakeGitHubOps();
      const result = await runGithubPipeline({
        repoDir,
        baseRef: "base",
        headRef: "HEAD",
        actor: "dependabot[bot]",
        testCommand:
          'node -e "require(\'reflect-metadata\'); require(\'@nestjs/core\')"',
        github,
        autoMerge: true,
      });

      assert.equal(result.status, "cross-file-verdict");
      if (result.status === "cross-file-verdict") {
        assert.equal(result.bump.name, "@nestjs/core");
        assert.equal(result.bump.toVersion, "11.2.3");
        assert.equal(result.results.length, 2);
        const paths = result.results.map((r) => r.bump.packageJsonPath).sort();
        assert.deepEqual(paths, ["apps/gateway/package.json", "apps/notifier/package.json"]);
        for (const { step } of result.results) {
          assert.equal(step.kind, "verdict");
          if (step.kind === "verdict") {
            assert.equal(step.verdict.kind, "PASSED");
          }
        }
        assert.equal(result.merged, true);
      }

      assert.equal(github.comments.length, 1);
      assert.match(github.comments[0]!.body, /@nestjs\/core.*bumped across 2 apps/);
      assert.match(github.comments[0]!.body, /apps\/gateway\/package\.json/);
      assert.match(github.comments[0]!.body, /apps\/notifier\/package\.json/);
      assert.equal(github.checkRuns.length, 1);
      assert.equal(github.checkRuns[0]!.conclusion, "success");
      assert.equal(github.mergeCalls, 1);
    } finally {
      await rm(repoDir, { recursive: true, force: true });
    }
  },
);
