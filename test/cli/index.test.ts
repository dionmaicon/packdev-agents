import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { symlink, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const cliJs = path.join(repoRoot, "dist", "cli", "index.js");

/**
 * Exercises the actual COMPILED entrypoint (built by the `pretest` script),
 * same rationale as github-action/main.test.ts: proves the process boots
 * and reads env-based config correctly, without needing a real forge
 * token. poll.test.ts / registry.test.ts already cover the actual
 * polling/provider-resolution decision logic in depth.
 *
 * Replaces the old test/adapters/selfhosted/main.test.ts, which spawned
 * dist/adapters/selfhosted/main.js — deleted along with that file when
 * selfhosted/main.ts and agentic-triage/mainGitea.ts were consolidated
 * into this single CLI. That old test kept passing locally purely because
 * of a stale dist/ left over from before the deletion; a truly clean
 * `rm -rf dist && npm run build && npm test` failed with MODULE_NOT_FOUND
 * (caught in code review) — this file targets the real current entrypoint
 * instead.
 */
async function runCli(
  args: string[],
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const result = await execFileAsync("node", [cliJs, ...args], {
    env: { ...process.env, ...env },
  }).catch((error: { stdout: string; stderr: string; code: number }) => error);

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: "code" in result ? (result.code ?? 0) : 0,
  };
}

test("no subcommand -> prints usage and exits 1", async () => {
  const { stderr, exitCode } = await runCli([], {});
  assert.equal(exitCode, 1);
  assert.match(stderr, /Usage: packdev-agents <compat\|triage>/);
});

test("unknown subcommand -> prints usage and exits 1", async () => {
  const { stderr, exitCode } = await runCli(["bogus", "--once"], {});
  assert.equal(exitCode, 1);
  assert.match(stderr, /Usage: packdev-agents <compat\|triage>/);
});

test("compat --once: missing REPO -> fails with a clear message, no stack trace crash", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {});
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing required environment variable: REPO/);
});

test("compat --once: REPO set but missing GITHUB_TOKEN (default PROVIDER=github) -> fails with a clear message", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], { REPO: "octocat/hello-world" });
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing required environment variable: GITHUB_TOKEN/);
});

test("compat --once: malformed REPO (no slash) -> fails with a clear message", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPO: "not-owner-slash-repo",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REPO must be "owner\/repo"/);
});

test("compat --once: provider resolves fine but neither TEST_COMMAND nor TEST_SCRIPT set -> fails with a clear message", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /Exactly one of TEST_COMMAND\/TEST_SCRIPT/);
});

test("triage --once: does NOT require TEST_COMMAND/TEST_SCRIPT — fails on the model provider instead, proving the CR3 fix", async () => {
  const { stderr, exitCode } = await runCli(["triage", "--once"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.doesNotMatch(stderr, /TEST_COMMAND/);
  assert.match(stderr, /Missing required environment variable: ANTHROPIC_API_KEY/);
});

test("unset (loop mode): POLL_INTERVAL_SECONDS=0 is rejected before starting the loop", async () => {
  const { stderr, exitCode } = await runCli(["compat"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
    TEST_COMMAND: "true",
    POLL_INTERVAL_SECONDS: "0",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /POLL_INTERVAL_SECONDS must be a positive number/);
});

test("unset (loop mode): POLL_INTERVAL_SECONDS=notanumber is rejected before starting the loop", async () => {
  const { stderr, exitCode } = await runCli(["compat"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
    TEST_COMMAND: "true",
    POLL_INTERVAL_SECONDS: "notanumber",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /POLL_INTERVAL_SECONDS must be a positive number/);
});

test("compat --once: REPO with extra path segments is rejected, not silently truncated", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPO: "owner/repo/extra",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REPO must be "owner\/repo"/);
});

test("compat --once: TEST_COMBINED_BUMP=ture (typo) is rejected instead of silently treated as false", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
    TEST_COMMAND: "true",
    TEST_COMBINED_BUMP: "ture",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /TEST_COMBINED_BUMP must be "true" or "false"/);
});

test("triage --once: MAX_TURNS=notanumber is rejected before any network call", async () => {
  const { stderr, exitCode } = await runCli(["triage", "--once"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
    MAX_TURNS: "notanumber",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /MAX_TURNS must be a positive integer/);
});

test("triage --once: MAX_TURNS=0 is rejected", async () => {
  const { stderr, exitCode } = await runCli(["triage", "--once"], {
    REPO: "octocat/hello-world",
    GITHUB_TOKEN: "fake",
    MAX_TURNS: "0",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /MAX_TURNS must be a positive integer/);
});

test("compat --once: PROVIDER=gitea missing GITEA_USERNAME -> fails with a clear message", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPO: "owner/repo",
    PROVIDER: "gitea",
    GITEA_URL: "https://gitea.example.com",
    GITEA_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /Missing required environment variable: GITEA_USERNAME/);
});

test("compat --once: REPO and REPOS both set -> clear mutually-exclusive error", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPO: "owner/repo",
    REPOS: "owner/a,owner/b",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REPO and REPOS are mutually exclusive/);
});

test("compat --once: REPOS with one entry malformed among several -> whole run fails fast, config error names it", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPOS: "owner/good,not-owner-slash-repo",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REPO must be "owner\/repo"/);
});

test("compat --once: REPOS + REMOTE_URL together -> rejected, ambiguous which repo it applies to", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPOS: "owner/a,owner/b",
    GITHUB_TOKEN: "fake",
    REMOTE_URL: "https://example.test/custom.git",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REMOTE_URL cannot be used with multiple REPOS/);
});

test("compat --once: REPOS empty after trimming -> clear error", async () => {
  const { stderr, exitCode } = await runCli(["compat", "--once"], {
    REPOS: " , ,",
    GITHUB_TOKEN: "fake",
  });
  assert.equal(exitCode, 1);
  assert.match(stderr, /REPOS must contain at least one "owner\/repo"/);
});

test("invoked through a SYMLINK (npm's actual bin mechanism) -> main() still runs, not silently a no-op", async () => {
  // Reproduces npm's real bin layout: node_modules/.bin/packdev-agents is
  // a symlink to dist/cli/index.js. process.argv[1] reports the symlink
  // path as typed; import.meta.url is the real file's own location — a
  // naive equality check between the two never matches here, which would
  // make main() silently never execute (exit 0, no output, nothing run).
  const symlinkDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-symlink-"));
  const symlinkPath = path.join(symlinkDir, "packdev-agents-bin");
  try {
    await symlink(cliJs, symlinkPath);
    const result = await execFileAsync("node", [symlinkPath], {
      env: { ...process.env },
    }).catch((error: { stdout: string; stderr: string; code: number }) => error);
    const exitCode = "code" in result ? (result.code ?? 0) : 0;
    assert.equal(exitCode, 1);
    assert.match(result.stderr, /Usage: packdev-agents <compat\|triage>/);
  } finally {
    await rm(symlinkDir, { recursive: true, force: true });
  }
});
