import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

import type { CompatReport } from "./packdevTypes.js";

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
 * Resolves packdev's CLI entry script on disk. NEVER `require("packdev")`
 * or `import` its named exports for this purpose: packdev's package.json
 * has "main": "dist/index.js" with no "exports" map, and that file IS the
 * CLI entry — it calls program.parse() as a side effect at module load, so
 * importing it would execute the CLI in-process instead of letting us spawn
 * and capture it. See docs/architecture.md "Shell out, do not import".
 */
async function resolvePackdevBinPath(): Promise<string> {
  const require = createRequire(import.meta.url);
  const packageJsonPath = require.resolve("packdev/package.json");
  const packageDir = path.dirname(packageJsonPath);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    bin?: Record<string, string> | string;
  };

  const binField = packageJson.bin;
  const relativeBin =
    typeof binField === "string" ? binField : binField?.packdev;
  if (!relativeBin) {
    throw new Error(
      `packdev's package.json at ${packageJsonPath} has no "bin.packdev" entry`,
    );
  }
  return path.join(packageDir, relativeBin);
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

  return { report, exitCode, stderr };
}
