import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { ApiDiffReport } from "./packdevTypes.js";
import { resolvePackdevBinPath } from "./packdevBin.js";
import { buildSandboxEnv } from "./childEnv.js";

const execFileAsync = promisify(execFile);

export interface RunApiDiffOptions {
  /** Directory to scan for usage — same appDir runCompat would use. */
  appDir: string;
  packageName: string;
  /**
   * The exact candidate version to check. A bare version string (no
   * operator) is itself a valid semver range that matches only that
   * version, so this scopes api-diff to exactly the Dependabot-bumped
   * version instead of a spread of versions we have no use for here.
   */
  toVersion: string;
  registryUrl?: string | undefined;
  extraArgs?: string[] | undefined;
  /** Overrides CLI entry-point resolution. Test-only escape hatch. */
  binPathOverride?: string | undefined;
}

export interface RunApiDiffResult {
  report: ApiDiffReport;
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
 * Spawns `packdev api-diff --json` scoped to exactly the bumped version and
 * parses its JSON report. Static — no sandboxed install — so this is safe
 * to run before the expensive per-version compat sandbox as a fast
 * pre-check. Never throws on packdev's own nonzero exit codes; only throws
 * when stdout isn't valid JSON.
 */
export async function runApiDiff(
  options: RunApiDiffOptions,
): Promise<RunApiDiffResult> {
  const binPath = options.binPathOverride ?? (await resolvePackdevBinPath());

  const args = [
    binPath,
    "api-diff",
    options.packageName,
    "--range",
    options.toVersion,
    "--app",
    ".",
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
      // No install happens here (static analysis only), but strips
      // GITHUB_TOKEN/brain API keys from this process tree regardless —
      // see childEnv.ts.
      env: buildSandboxEnv(),
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

  let report: ApiDiffReport;
  try {
    report = JSON.parse(stdout) as ApiDiffReport;
  } catch (parseError) {
    throw new Error(
      `packdev api-diff did not produce valid JSON on stdout (exit ${exitCode}): ${String(parseError)}\n` +
        `stdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`,
    );
  }

  // Same defensive shape check as runCompat.ts: valid JSON but not an
  // ApiDiffReport means packdev rejected the input (its own error shape is
  // {command, package, success: false, error}) — surface that clearly
  // instead of handing pipeline.ts a report with no `versions` array.
  if (!Array.isArray(report.versions)) {
    const asError = report as unknown as { error?: string; success?: boolean };
    throw new Error(
      `packdev api-diff did not return an ApiDiffReport (exit ${exitCode})` +
        (asError.error ? `: ${asError.error}` : "") +
        `\nstdout: ${stdout.slice(0, 2000)}\nstderr: ${stderr.slice(0, 2000)}`,
    );
  }

  return { report, exitCode, stderr };
}
