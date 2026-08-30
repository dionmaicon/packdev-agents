import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCombinedTest } from "../../src/core/runCombinedTest.ts";

async function makeDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-combined-test-"));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("runCombinedTest: exit 0 -> kind: passed", async () => {
  const { dir, cleanup } = await makeDir();
  try {
    const result = await runCombinedTest({
      appDir: dir,
      packageManager: "npm",
      testCommand: "true",
    });
    assert.equal(result.kind, "passed");
  } finally {
    await cleanup();
  }
});

test("runCombinedTest: nonzero exit -> kind: failed, with the real exit code and output", async () => {
  const { dir, cleanup } = await makeDir();
  try {
    const result = await runCombinedTest({
      appDir: dir,
      packageManager: "npm",
      testCommand: "node -e \"console.log('boom'); process.exit(3)\"",
    });
    assert.equal(result.kind, "failed");
    if (result.kind === "failed") {
      assert.equal(result.exitCode, 3);
      assert.match(result.output, /boom/);
    }
  } finally {
    await cleanup();
  }
});

test(
  "runCombinedTest: a hung process past timeoutMs -> kind: error (harness problem), NOT kind: failed -- previously this collapsed into a fake exit code 1, misreporting an environment problem as a real test failure",
  { timeout: 30_000 },
  async () => {
    const { dir, cleanup } = await makeDir();
    try {
      const result = await runCombinedTest({
        appDir: dir,
        packageManager: "npm",
        testCommand: "node -e \"setInterval(() => {}, 1000)\"", // never exits on its own
        timeoutMs: 1000,
      });
      assert.equal(result.kind, "error");
      if (result.kind === "error") {
        assert.match(result.message, /timeout|signal/i);
      }
    } finally {
      await cleanup();
    }
  },
);

test("runCombinedTest: a genuine spawn failure (package manager binary doesn't exist on PATH) -> kind: error, NOT kind: failed with a fake exit code", async () => {
  const { dir, cleanup } = await makeDir();
  try {
    const result = await runCombinedTest({
      appDir: dir,
      // Not a real package manager binary — execFile itself never starts
      // the process (ENOENT), the exact case the old code collapsed into
      // a fake "kind: failed, exitCode: 1" (typeof error.code === "number"
      // was false for a string ENOENT code, so it silently fell to the
      // default 1 instead of surfacing this as an infra problem).
      packageManager: "packdev-agents-test-nonexistent-pm" as never,
      testScript: "test",
    });
    assert.equal(result.kind, "error");
    if (result.kind === "error") {
      assert.match(result.message, /ENOENT|not found|no such file/i);
    }
  } finally {
    await cleanup();
  }
});
