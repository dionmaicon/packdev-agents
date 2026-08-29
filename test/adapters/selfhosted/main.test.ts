import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const mainJs = path.join(repoRoot, "dist", "adapters", "selfhosted", "main.js");

/**
 * Exercises the actual COMPILED entrypoint (built by the `pretest` script),
 * the same rationale as github-action/main.test.ts: proves the process
 * boots and reads env-based config correctly, without needing a real
 * GitHub token. poll.test.ts already covers the actual polling/state
 * decision logic in depth against a real git remote.
 */
async function runMain(
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execFileAsync("node", [mainJs, "--once"], {
    env: { ...process.env, ...env },
  }).catch((error: { stdout: string; stderr: string; code: number }) => error);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: "code" in result ? (result.code ?? 0) : 0,
  };
}

test("main.js --once: missing REPO -> fails with a clear message, no stack trace crash", async () => {
  const { stderr, exitCode } = await runMain({});
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing required environment variable: REPO/);
});

test("main.js --once: REPO set but missing GITHUB_TOKEN -> fails with a clear message", async () => {
  const { stderr, exitCode } = await runMain({ REPO: "octocat/hello-world" });
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing required environment variable: GITHUB_TOKEN/);
});

test("main.js --once: malformed REPO (no slash) -> fails with a clear message", async () => {
  const { stderr, exitCode } = await runMain({
    REPO: "not-owner-slash-repo",
    GITHUB_TOKEN: "fake",
    TEST_COMMAND: "true",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REPO must be "owner\/repo"/);
});
