import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

const DEPENDENCY_SECTIONS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
] as const;

export type DependencySection = (typeof DEPENDENCY_SECTIONS)[number];

export interface Bump {
  name: string;
  fromVersion: string;
  toVersion: string;
  section: DependencySection;
  /** Which package.json this bump was found in, relative to repoDir. */
  packageJsonPath: string;
}

export interface Unsupported {
  kind: "unsupported";
  reason: string;
  /** Populated for the grouped-PR case: every package this PR bumped, possibly across multiple package.json files. */
  bumps: Bump[];
}

export interface ExtractBumpOptions {
  /** Path to the git working directory (must contain the repo). */
  repoDir: string;
  baseRef: string;
  headRef: string;
  /**
   * Optional. When given, ONLY this file is checked (an explicit override —
   * useful to pin scanning to one directory in a repo with unrelated
   * package.json churn elsewhere). When omitted (the default, and the right
   * choice for a monorepo with more than one independently-Dependabot-
   * tracked workspace member), every package.json that actually changed
   * between baseRef and headRef is discovered and checked — a fixed single
   * path can't work once more than one workspace member has its own
   * Dependabot config, since each gets its own PR touching a different file.
   */
  packageJsonPath?: string;
}

type PackageJsonDeps = Partial<Record<DependencySection, Record<string, string>>>;

/**
 * A dependency specifier that isn't a registry version and therefore isn't
 * something `packdev compat` can test candidate versions of.
 */
function isRegistrySpecifier(spec: string): boolean {
  return !/^(workspace:|file:|link:|git\+|git:|https?:|\*$)/.test(spec.trim());
}

async function readPackageJsonAt(
  repoDir: string,
  ref: string,
  packageJsonPath: string,
): Promise<PackageJsonDeps> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["show", `${ref}:${packageJsonPath}`],
      { cwd: repoDir, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `Could not read ${packageJsonPath} at ${ref} in ${repoDir}: ${String(error)}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `${packageJsonPath} at ${ref} is not valid JSON: ${String(error)}`,
    );
  }

  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`${packageJsonPath} at ${ref} is not a JSON object`);
  }
  return parsed as PackageJsonDeps;
}

/** Every real dependency-version bump found in one specific package.json between two refs. Usually zero or one; more than one means a grouped update within that single file. */
async function bumpsInFile(
  repoDir: string,
  baseRef: string,
  headRef: string,
  packageJsonPath: string,
): Promise<Bump[]> {
  const [basePkg, headPkg] = await Promise.all([
    readPackageJsonAt(repoDir, baseRef, packageJsonPath),
    readPackageJsonAt(repoDir, headRef, packageJsonPath),
  ]);

  const bumps: Bump[] = [];

  for (const section of DEPENDENCY_SECTIONS) {
    const baseDeps = basePkg[section] ?? {};
    const headDeps = headPkg[section] ?? {};

    for (const [name, toVersion] of Object.entries(headDeps)) {
      const fromVersion = baseDeps[name];
      if (fromVersion === undefined) continue; // newly added dep, not a bump
      if (fromVersion === toVersion) continue;
      if (!isRegistrySpecifier(fromVersion) || !isRegistrySpecifier(toVersion)) {
        continue; // e.g. workspace:/file:/git — not a registry version bump
      }
      bumps.push({ name, fromVersion, toVersion, section, packageJsonPath });
    }
  }

  return bumps;
}

/**
 * Every package.json that differs between baseRef and headRef, relative to
 * repoDir — the candidate set for auto-discovery. Excludes anything under
 * node_modules defensively (should never be tracked, but a repo that
 * accidentally committed it shouldn't make discovery scan it).
 */
async function discoverChangedPackageJsonPaths(
  repoDir: string,
  baseRef: string,
  headRef: string,
): Promise<string[]> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", baseRef, headRef],
      { cwd: repoDir, maxBuffer: 10 * 1024 * 1024 },
    ));
  } catch (error) {
    throw new Error(
      `Could not diff ${baseRef}..${headRef} in ${repoDir}: ${String(error)}`,
    );
  }

  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((filePath) => path.basename(filePath) === "package.json")
    .filter((filePath) => !filePath.split("/").includes("node_modules"));
}

/**
 * Identifies what a bot PR actually bumped by diffing package.json between
 * the PR's base and head refs — NOT by parsing the PR title, which is
 * bot-formatted and varies across Dependabot/Renovate, ecosystem, and
 * grouped-update configuration.
 *
 * Returns Unsupported when zero or more than one dependency's version
 * changed (whether within one file or spread across several — a monorepo
 * with multiple independently-tracked workspace members can have either):
 * a grouped update bumps several packages in one PR, and guessing which one
 * to test would produce a verdict that doesn't answer the PR.
 */
export async function extractBump(
  options: ExtractBumpOptions,
): Promise<Bump | Unsupported> {
  const filesToCheck = options.packageJsonPath
    ? [options.packageJsonPath]
    : await discoverChangedPackageJsonPaths(options.repoDir, options.baseRef, options.headRef);

  const bumpLists = await Promise.all(
    filesToCheck.map((filePath) =>
      bumpsInFile(options.repoDir, options.baseRef, options.headRef, filePath),
    ),
  );
  const bumps = bumpLists.flat();

  if (bumps.length === 0) {
    return {
      kind: "unsupported",
      reason: options.packageJsonPath
        ? `No dependency version change found in ${options.packageJsonPath} between base and head`
        : "No dependency version change found in any package.json between base and head",
      bumps: [],
    };
  }

  if (bumps.length > 1) {
    return {
      kind: "unsupported",
      reason: `Grouped update: ${bumps.length} packages bumped in one PR`,
      bumps,
    };
  }

  return bumps[0]!;
}

export function isUnsupported(result: Bump | Unsupported): result is Unsupported {
  return "kind" in result && result.kind === "unsupported";
}
