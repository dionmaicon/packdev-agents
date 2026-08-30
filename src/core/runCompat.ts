import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CompatReport } from "./packdevTypes.js";
import { resolvePackdevBinPath } from "./packdevBin.js";

const execFileAsync = promisify(execFile);

export interface RunCompatOptions {
  /** Directory prepared by prepareWorkspace — packdev copies this into its own sandbox. */
  appDir: string;
  packageName: string;
  /**
   * Exact version(s) to test. v1 passes exactly the Dependabot-bumped
   * version; packdev separately resolves the control from node_modules
   * (see docs/architecture.md "The control problem" — prepareWorkspace must
   * have installed the PRE-bump version for that control to mean anything).
   */
  versions: string[];
  testCommand: string;
  registryUrl?: string | undefined;
  extraArgs?: string[] | undefined;
  /** Overrides CLI entry-point resolution. Test-only escape hatch. */
  binPathOverride?: string | undefined;
}

export interface RunCompatResult {
  report: CompatReport;
  exitCode: number;
  stderr: string;
}

interface ExecFileErrorLike {
  code?: number;
  stdout?: string;
  stderr?: string;
}

function isExecFileErrorLike(error: unknown): error is ExecFileErrorLike {
  return typeof error === "object" && error !== null && "code" in error;
}

/**
 * Spawns `packdev compat --json` against a prepared workspace and parses
 * its JSON report from stdout. Never throws on packdev's own nonzero exit
 * codes (6 NOTHING_TESTED, 7 COMPAT_FAILED are meaningful results, not
 * process failures) — only throws when stdout isn't valid JSON, which is
 * always a hard error, never a silent fallback.
 */
export async function runCompat(
  options: RunCompatOptions,
): Promise<RunCompatResult> {
  const binPath = options.binPathOverride ?? (await resolvePackdevBinPath());

  const args = [
    binPath,
    "compat",
    options.packageName,
    "--versions",
    options.versions.join(","),
    "--test",
    options.testCommand,
    "--json",
    ...(options.registryUrl ? ["--registry", options.registryUrl] : []),
    ...(options.extraArgs ?? []),
  ];

  let stdout: string;
  let stderr: string;
  let exitCode: number;

  try {
    const result = await execFileAsync(process.execPath, args, {
      cwd: options.appDir,
      maxBuffer: 50 * 1024 * 1024,
    });
    stdout = result.stdout;
    stderr = result.stderr;
    exitCode = 0;
  } catch (error) {
    if (!isExecFileErrorLike(error)) throw error;
    stdout = error.stdout ?? "";
    stderr = error.stderr ?? "";
    exitCode = typeof error.code === "number" ? error.code : 1;
  }

  let report: CompatReport;
  try {
    report = JSON.parse(stdout) as CompatReport;
  } catch (parseError) {
    throw new Error(
      `packdev compat did not produce valid JSON on stdout (exit ${exitCode}): ${String(parseError)}\n` +
        `stdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`,
    );
  }

  // Valid JSON but not a CompatReport: packdev's own input-rejection shape
  // is `{command, package, success: false, error}` (e.g. an invalid/range
  // version string — see extractBump.ts's toConcreteVersion doc comment
  // for a confirmed real example). Silently proceeding would hand
  // interpret() a report with no `versions` array, which crashes deep in
  // candidatesOf() rather than surfacing what actually went wrong.
  if (!Array.isArray(report.versions)) {
    const asError = report as unknown as { error?: string; success?: boolean };
    throw new Error(
      `packdev compat did not return a CompatReport (exit ${exitCode})` +
        (asError.error ? `: ${asError.error}` : "") +
        `\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`,
    );
  }

  return { report, exitCode, stderr };
}
