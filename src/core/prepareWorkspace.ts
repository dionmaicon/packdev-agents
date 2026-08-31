import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildSandboxEnv } from "./childEnv.js";

const execFileAsync = promisify(execFile);

export type PackageManagerName = "npm" | "yarn" | "pnpm";

export interface Workspace {
  /** Directory holding the checked-out base-ref tree, already installed. */
  dir: string;
  packageManager: PackageManagerName;
  /** Removes the temp directory. Always call this when done with the workspace. */
  cleanup: () => Promise<void>;
}

export interface PrepareWorkspaceOptions {
  /** Path to an existing git checkout containing baseRef. */
  repoDir: string;
  baseRef: string;
  /** package.json path relative to the workspace root. Defaults to "package.json". */
  packageJsonPath?: string;
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Mirrors packdev's own package-manager resolution order (nearest
 * package.json "packageManager" field / corepack, then nearest lockfile) so
 * our install agrees with what packdev's sandbox install will do. Exported
 * so the field-vs-lockfile precedence can be unit tested directly, without
 * paying for a real install per case.
 */
export async function detectPackageManager(
  dir: string,
  packageJsonPath: string,
): Promise<PackageManagerName> {
  try {
    const raw = await readFile(path.join(dir, packageJsonPath), "utf8");
    const pkg = JSON.parse(raw) as { packageManager?: string };
    if (pkg.packageManager) {
      const name = pkg.packageManager.split("@")[0];
      if (name === "npm" || name === "yarn" || name === "pnpm") return name;
    }
  } catch {
    // fall through to lockfile detection
  }

  if (await exists(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (await exists(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Yarn classic (v1) runs install scripts by default and needs the
 * `--ignore-scripts` flag told to it explicitly (confirmed empirically).
 * Yarn Berry (v2+) has NO such flag at all — passing it is a hard CLI
 * syntax error that aborts the entire install, breaking every Berry repo
 * this tool would otherwise work on. Berry also already disables build
 * scripts by DEFAULT (confirmed empirically: "lists build scripts, but
 * all build scripts have been disabled" with no flag/config at all), so
 * the flag would be pure downside there — not a defense we're giving up.
 * Prefers package.json's "packageManager" field (exact version, no
 * process spawn needed) and falls back to `yarn --version`; if neither
 * resolves, treats it as "don't add the flag" — Berry's already safe by
 * default, so failing to detect only leaves a residual gap on classic v1
 * with an unparseable version output, not a functional break for anyone.
 */
async function yarnNeedsIgnoreScriptsFlag(dir: string, packageJsonPath: string): Promise<boolean> {
  try {
    const raw = await readFile(path.join(dir, packageJsonPath), "utf8");
    const pkg = JSON.parse(raw) as { packageManager?: string };
    const match = pkg.packageManager ? /^yarn@(\d+)\./.exec(pkg.packageManager) : null;
    if (match) return Number(match[1]) < 2;
  } catch {
    // fall through to spawning `yarn --version`
  }

  try {
    const { stdout } = await execFileAsync("yarn", ["--version"]);
    const match = /^(\d+)\./.exec(stdout.trim());
    if (match) return Number(match[1]) < 2;
  } catch {
    // yarn not on PATH, or version unparseable — see doc comment above
  }

  return false;
}

/**
 * --ignore-scripts (npm/pnpm always; yarn only when classic v1 — see
 * yarnNeedsIgnoreScriptsFlag) is load-bearing, not an optimization: this
 * install runs whatever version of whatever package a PR's
 * package.json/lockfile says, and package.json content is exactly what an
 * attacker-controlled bump PR gets to write. Without it, a malicious
 * postinstall/preinstall script runs with the full permissions of the CI
 * runner (or self-hosted host) the moment this function is called — a
 * complete RCE primitive gated only on getting a compromised version
 * published and bumped to. Real npm/yarn/pnpm scripts a legitimate app
 * needs (codegen, native builds) still run fine; they just don't run HERE,
 * inside the untrusted-content install this repo performs on the app's
 * behalf.
 */
export async function installCommand(
  packageManager: PackageManagerName,
  dir: string,
  packageJsonPath = "package.json",
): Promise<{ command: string; args: string[] }> {
  switch (packageManager) {
    case "npm":
      return (await exists(path.join(dir, "package-lock.json")))
        ? { command: "npm", args: ["ci", "--no-audit", "--no-fund", "--ignore-scripts"] }
        : { command: "npm", args: ["install", "--no-audit", "--no-fund", "--ignore-scripts"] };
    case "yarn": {
      const ignoreScriptsArgs = (await yarnNeedsIgnoreScriptsFlag(dir, packageJsonPath))
        ? ["--ignore-scripts"]
        : [];
      return (await exists(path.join(dir, "yarn.lock")))
        ? { command: "yarn", args: ["install", "--frozen-lockfile", ...ignoreScriptsArgs] }
        : { command: "yarn", args: ["install", ...ignoreScriptsArgs] };
    }
    case "pnpm":
      return (await exists(path.join(dir, "pnpm-lock.yaml")))
        ? { command: "pnpm", args: ["install", "--frozen-lockfile", "--ignore-scripts"] }
        : { command: "pnpm", args: ["install", "--ignore-scripts"] };
  }
}

/**
 * Checks out the PR's BASE ref (never the head) into a fresh temp
 * directory and runs a real install there. This is the control guard, not
 * an optimization: packdev's `compat` resolves its control (the
 * currently-installed version) from node_modules, never from
 * --versions/--range. Installing from the PR head would leave node_modules
 * holding the already-bumped version, degenerating the control into the
 * candidate and silently killing the harness-sanity check. See
 * docs/architecture.md "The control problem".
 */
export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<Workspace> {
  const packageJsonPath = options.packageJsonPath ?? "package.json";
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-workspace-"));

  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true });
  };

  try {
    // git archive avoids leaving a linked worktree behind and never
    // includes .git/ignored/untracked cruft — dir is exactly baseRef's
    // tracked tree.
    await execFileAsync(
      "sh",
      [
        "-c",
        `git archive "${options.baseRef}" | tar -x -C "${dir}"`,
      ],
      { cwd: options.repoDir, maxBuffer: 200 * 1024 * 1024 },
    );

    if (!(await exists(path.join(dir, packageJsonPath)))) {
      throw new Error(
        `${packageJsonPath} not found in ${options.baseRef} after checkout into ${dir}`,
      );
    }

    const packageManager = await detectPackageManager(dir, packageJsonPath);
    const { command, args } = await installCommand(packageManager, dir, packageJsonPath);

    await execFileAsync(command, args, {
      cwd: dir,
      maxBuffer: 200 * 1024 * 1024,
      // ignoreScripts belongs here specifically: this is an install of
      // PR-influenced dependencies and NO app test command runs in this
      // child, so there is no lifecycle hook it can wrongly suppress —
      // unlike the packdev/test-command children, which is what made the
      // old blanket default a real bug (see childEnv.ts). Reinforces the
      // explicit --ignore-scripts flag installCommand already passes,
      // which yarn v1 classic doesn't reliably honor on its own.
      env: buildSandboxEnv(process.env, { ignoreScripts: true }),
    });

    return { dir, packageManager, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
