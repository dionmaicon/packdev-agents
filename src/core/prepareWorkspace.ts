import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

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

/** Exported for the same reason as detectPackageManager: unit test the frozen-lockfile-vs-not branching directly. */
export async function installCommand(
  packageManager: PackageManagerName,
  dir: string,
): Promise<{ command: string; args: string[] }> {
  switch (packageManager) {
    case "npm":
      return (await exists(path.join(dir, "package-lock.json")))
        ? { command: "npm", args: ["ci", "--no-audit", "--no-fund"] }
        : { command: "npm", args: ["install", "--no-audit", "--no-fund"] };
    case "yarn":
      return (await exists(path.join(dir, "yarn.lock")))
        ? { command: "yarn", args: ["install", "--frozen-lockfile"] }
        : { command: "yarn", args: ["install"] };
    case "pnpm":
      return (await exists(path.join(dir, "pnpm-lock.yaml")))
        ? { command: "pnpm", args: ["install", "--frozen-lockfile"] }
        : { command: "pnpm", args: ["install"] };
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
    const { command, args } = await installCommand(packageManager, dir);

    await execFileAsync(command, args, {
      cwd: dir,
      maxBuffer: 200 * 1024 * 1024,
    });

    return { dir, packageManager, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
