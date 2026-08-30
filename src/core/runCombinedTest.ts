import { spawn } from "node:child_process";

import type { PackageManagerName } from "./prepareWorkspace.js";
import { buildSandboxEnv } from "./childEnv.js";

/** 5 minutes — matches the order of magnitude of agentLoop.ts's own request timeout, added after a real stuck-provider incident. */
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
/** Grace period after SIGTERM before escalating to SIGKILL for anything that ignored it. */
const KILL_GRACE_MS = 5000;
/** Loose guard against runaway output, not a hard byte-exact cap. */
const MAX_OUTPUT_CHARS = 200_000;

export interface RunCombinedTestOptions {
  /** A workspace checked out at the PR's real HEAD ref — every independent bump applied at once, not held in isolation. */
  appDir: string;
  packageManager: PackageManagerName;
  testCommand?: string | undefined;
  testScript?: string | undefined;
  /**
   * Kills the test process (and everything it spawned) if it hasn't
   * finished by this point. Without this, a hanging test suite (an open
   * server handle, a broken watch-mode invocation — real risks since the
   * test command runs arbitrary, PR-influenced dependency behavior)
   * hangs until GitHub Actions' own job-level timeout-minutes kills the
   * whole job, with no graceful "stuck, not just slow" degradation.
   * Defaults to 5 minutes.
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
 * when the harness is what broke, not the code being tested).
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
 *
 * Spawns into a detached process GROUP and tracks its own timeout timer
 * rather than using execFile's built-in `timeout` option — two real bugs
 * that option has for this use case, both caught in review:
 *
 * 1. execFile's `timeout` only signals the immediate child it spawned.
 *    For `testScript` that child is npm/yarn/pnpm, which itself shells
 *    out to run the actual script body (an `sh -c` grandchild), which
 *    can itself spawn further processes (a dev server, a watcher) —
 *    none of which execFile's timeout ever reaches, so a hang could
 *    survive "our own" timeout with grandchildren still holding the
 *    stdout/stderr pipes open. `detached: true` puts the whole tree in
 *    its own process group; `process.kill(-pid, signal)` (a negative
 *    pid) on POSIX signals every process in that group at once.
 * 2. execFile's timeout sets `killed: true` on its error, but a child
 *    that catches SIGTERM and exits on its own with a real numeric exit
 *    code reports THAT code with `signal` unset — a naive check of
 *    `signal` (or `signal` before `killed`) then misclassifies a
 *    genuine timeout as an ordinary test failure. Tracking our own
 *    `timedOut` flag, set only by our own timer, sidesteps this
 *    ambiguity entirely: it's true if and only if WE decided this took
 *    too long, independent of how the child happened to react to being
 *    signaled.
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

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const child = spawn(command!, args, {
      cwd: options.appDir,
      env: buildSandboxEnv(),
      // Windows has no process-group-kill equivalent via a negative pid
      // — detached there just runs the child without a console window,
      // and killGroup below falls back to signaling the direct child
      // only, a known platform limitation this can't fully work around.
      detached: process.platform !== "win32",
    });

    const killGroup = (signal: NodeJS.Signals): void => {
      if (child.pid === undefined) return;
      try {
        process.kill(process.platform === "win32" ? child.pid : -child.pid, signal);
      } catch {
        // ESRCH etc — already gone, nothing to do.
      }
    };

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      const killTimer = setTimeout(() => killGroup("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
    }, timeoutMs);
    timeoutTimer.unref();

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      resolve({ kind: "error", message: error.message, output: `${stdout}\n${stderr}`.trim() });
    });

    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      const output = `${stdout}\n${stderr}`.trim();

      if (timedOut) {
        resolve({
          kind: "error",
          message: `the test process (and its process group) was killed after exceeding the ${timeoutMs}ms timeout`,
          output,
        });
        return;
      }
      if (signal) {
        resolve({ kind: "error", message: `the test process was terminated by signal ${signal}`, output });
        return;
      }
      resolve(code === 0 ? { kind: "passed", output } : { kind: "failed", exitCode: code ?? 1, output });
    });
  });
}
