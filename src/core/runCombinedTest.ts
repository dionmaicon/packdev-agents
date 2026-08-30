import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PackageManagerName } from "./prepareWorkspace.js";
import { buildSandboxEnv } from "./childEnv.js";

const execFileAsync = promisify(execFile);

/** 5 minutes — matches the order of magnitude of agentLoop.ts's own request timeout, added after a real stuck-provider incident. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export interface RunCombinedTestOptions {
  /** A workspace checked out at the PR's real HEAD ref — every independent bump applied at once, not held in isolation. */
  appDir: string;
  packageManager: PackageManagerName;
  testCommand?: string | undefined;
  testScript?: string | undefined;
  /**
   * Kills the test process if it hasn't finished by this point. Without
   * this, a hanging test suite (an open server handle, a broken
   * watch-mode invocation — real risks since the test command runs
   * arbitrary, PR-influenced dependency behavior) hangs until GitHub
   * Actions' own job-level timeout-minutes kills the whole job, with no
   * graceful "stuck, not just slow" degradation. Defaults to 5 minutes.
   */
  timeoutMs?: number | undefined;
}

/**
 * "failed" means the test process ran to completion and genuinely
 * reported failure — a real signal about this bump combination. "error"
 * means something about the HARNESS broke instead (a timeout, a signal
 * kill, or a spawn failure like a missing binary) and says nothing
 * reliable about whether the bumps themselves work — mirrors
 * interpret.ts's HARNESS_BROKEN precedence (never blame the candidate
 * when the harness is what broke, not the code being tested). Previously
 * this collapsed both cases into one bucket (exitCode defaulting to 1),
 * which could falsely tell a PR "these bumps don't work together" when
 * the real cause was an environment problem.
 */
export type RunCombinedTestResult =
  | { kind: "passed"; output: string }
  | { kind: "failed"; exitCode: number; output: string }
  | { kind: "error"; message: string; output: string };

/**
 * Runs the app's real test command/script directly — no packdev sandbox,
 * no control comparison. Exists specifically for IndependentBumps (see
 * extractBump.ts): per-package isolation runs (runCompatStep, reusing
 * packdev's own compat CLI) already answer "did THIS bump break
 * anything," each holding every other package at its pre-bump version.
 * That structurally cannot catch an interaction bug where two bumps are
 * each individually fine but conflict together — this answers that
 * different question by testing the PR's actual combined state as
 * committed.
 */
export async function runCombinedTest(
  options: RunCombinedTestOptions,
): Promise<RunCombinedTestResult> {
  if (!options.testCommand && !options.testScript) {
    throw new Error("runCombinedTest: exactly one of testCommand/testScript is required, got neither");
  }
  if (options.testCommand && options.testScript) {
    throw new Error("runCombinedTest: testCommand and testScript are mutually exclusive, got both");
  }

  const [command, ...args] = options.testScript
    ? [options.packageManager, "run", options.testScript]
    : ["sh", "-c", options.testCommand!];
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = await execFileAsync(command!, args, {
      cwd: options.appDir,
      maxBuffer: 50 * 1024 * 1024,
      timeout: timeoutMs,
      // This runs the app's own test command/script against a workspace
      // whose dependencies (including the bumped ones) were installed
      // with scripts disabled by prepareWorkspace, but the running test
      // process itself still shouldn't have GITHUB_TOKEN/brain API keys
      // in its env — see childEnv.ts.
      env: buildSandboxEnv(),
    });
    return { kind: "passed", output: `${result.stdout}\n${result.stderr}`.trim() };
  } catch (error) {
    const asExecError = error as {
      code?: number | string;
      signal?: string | null;
      killed?: boolean;
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    const output = `${asExecError.stdout ?? ""}\n${asExecError.stderr ?? ""}`.trim();

    // A signal-terminated process (our own timeout kill, an OOM kill, a
    // crash) never reported a real exit code — there's no genuine
    // pass/fail verdict to extract from it.
    if (asExecError.signal) {
      const reason = asExecError.killed
        ? `the test process was killed after exceeding the ${timeoutMs}ms timeout (signal ${asExecError.signal})`
        : `the test process was terminated by signal ${asExecError.signal}`;
      return { kind: "error", message: reason, output };
    }

    // A string error code here (e.g. "ENOENT") means the process never
    // actually started — a spawn failure (missing binary, permissions),
    // not a test result.
    if (typeof asExecError.code !== "number") {
      return {
        kind: "error",
        message: asExecError.message ?? `spawn failed: ${String(asExecError.code ?? "unknown error")}`,
        output,
      };
    }

    return { kind: "failed", exitCode: asExecError.code, output };
  }
}
