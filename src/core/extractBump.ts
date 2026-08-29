import { execFile } from "node:child_process";
import { promisify } from "node:util";

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
}

export interface Unsupported {
  kind: "unsupported";
  reason: string;
  /** Populated for the grouped-PR case: every package this PR bumped. */
  bumps: Bump[];
}

export interface ExtractBumpOptions {
  /** Path to the git working directory (must contain the repo). */
  repoDir: string;
  baseRef: string;
  headRef: string;
  /** package.json path relative to repoDir. Defaults to "package.json". */
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

/**
 * Identifies what a bot PR actually bumped by diffing package.json between
 * the PR's base and head refs — NOT by parsing the PR title, which is
 * bot-formatted and varies across Dependabot/Renovate, ecosystem, and
 * grouped-update configuration.
 *
 * Returns Unsupported when zero or more than one dependency's version
 * changed: a grouped update bumps several packages in one PR, and guessing
 * which one to test would produce a verdict that doesn't answer the PR.
 */
export async function extractBump(
  options: ExtractBumpOptions,
): Promise<Bump | Unsupported> {
  const packageJsonPath = options.packageJsonPath ?? "package.json";

  const [basePkg, headPkg] = await Promise.all([
    readPackageJsonAt(options.repoDir, options.baseRef, packageJsonPath),
    readPackageJsonAt(options.repoDir, options.headRef, packageJsonPath),
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
      bumps.push({ name, fromVersion, toVersion, section });
    }
  }

  if (bumps.length === 0) {
    return {
      kind: "unsupported",
      reason: "No dependency version change found between base and head package.json",
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
