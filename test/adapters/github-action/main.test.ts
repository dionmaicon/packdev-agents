import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const mainJs = path.join(repoRoot, "dist", "adapters", "github-action", "main.js");

/**
 * Exercises the actual COMPILED entrypoint (dist/adapters/github-action/main.js,
 * built by the `pretest` script) rather than the TS source — this is the
 * artifact action.yml actually spawns via `node .../main.js`, and NodeNext
 * module resolution / ESM import wiring is exactly the kind of thing that
 * type-checks fine but fails at runtime if misconfigured. pipeline.test.ts
 * already covers the decision logic in depth with a fake GitHubOps; these
 * tests only prove the process boots, reads env-based inputs, and routes
 * correctly for two paths that don't require a real GitHub token.
 */
async function runMain(
  eventPayload: unknown,
  extraEnv: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number; outputs: Record<string, string> }> {
  const eventDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-event-"));
  const eventPath = path.join(eventDir, "event.json");
  const outputPath = path.join(eventDir, "github-output.txt");
  await writeFile(eventPath, JSON.stringify(eventPayload));
  await writeFile(outputPath, "");

  try {
    const result = await execFileAsync(
      "node",
      [mainJs],
      {
        env: {
          ...process.env,
          GITHUB_EVENT_PATH: eventPath,
          GITHUB_EVENT_NAME: "pull_request",
          GITHUB_REPOSITORY: "octocat/hello-world",
          // Always route to a real temp file, overriding whatever the
          // outer process inherited — a real Actions runner always sets
          // GITHUB_OUTPUT, so @actions/core's setOutput writes there (a
          // file), never to stdout. Asserting on stdout only "worked" by
          // accident on a dev machine where this var happens to be unset.
          GITHUB_OUTPUT: outputPath,
          "INPUT_TEST-COMMAND": "true",
          "INPUT_GITHUB-TOKEN": "fake-token-not-used-on-these-paths",
          "INPUT_AUTO-MERGE": "false",
          "INPUT_ALLOWED-ACTORS": "",
          "INPUT_FAIL-STEP-ON-NON-PASS": "true",
          "INPUT_BRAIN": "none",
          ...extraEnv,
        },
      },
    ).catch((error: { stdout: string; stderr: string; code: number }) => error);

    const outputContents = await readFile(outputPath, "utf8").catch(() => "");
    const outputs: Record<string, string> = {};
    for (const match of outputContents.matchAll(/^([^=<]+)<<(\S+)\r?\n([\s\S]*?)\r?\n\2$/gm)) {
      outputs[match[1]!] = match[3]!;
    }

    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: "code" in result ? (result.code ?? 0) : 0,
      outputs,
    };
  } finally {
    await rm(eventDir, { recursive: true, force: true });
  }
}

test("main.js: no pull_request payload -> fails the step with a clear message, no crash", async () => {
  // @actions/core's setFailed emits an ::error:: workflow command on
  // stdout (that's how GitHub Actions annotates the log), not stderr.
  const { stdout, exitCode } = await runMain({});
  assert.equal(exitCode, 1);
  assert.match(stdout, /must be triggered by a pull_request event/);
});

test("main.js: actor not in allowed-actors -> exits 0, sets status output, makes no GitHub API call", async () => {
  const { stdout, exitCode, outputs } = await runMain({
    pull_request: {
      number: 1,
      user: { login: "some-human" },
      base: { sha: "0".repeat(40) },
      head: { sha: "1".repeat(40) },
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(outputs["status"], "skipped-actor");
  assert.match(stdout, /not in allowed-actors/);
});
