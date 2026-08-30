import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { PackageManagerName } from "./prepareWorkspace.js";

const execFileAsync = promisify(execFile);

export interface RunCombinedTestOptions {
  /** A workspace checked out at the PR's real HEAD ref — every independent bump applied at once, not held in isolation. */
  appDir: string;
  packageManager: PackageManagerName;
  testCommand?: string | undefined;
  testScript?: string | undefined;
}

export interface RunCombinedTestResult {
  passed: boolean;
  exitCode: number;
  output: string;
}

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

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    const result = await execFileAsync(command!, args, {
      cwd: options.appDir,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const asExecError = error as { code?: number; stdout?: string; stderr?: string };
    stdout = asExecError.stdout ?? "";
    stderr = asExecError.stderr ?? "";
    exitCode = typeof asExecError.code === "number" ? asExecError.code : 1;
  }

  return { passed: exitCode === 0, exitCode, output: `${stdout}\n${stderr}`.trim() };
}
