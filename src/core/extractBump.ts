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
  /**
   * Other packages this PR bumped ALONGSIDE this one, in the same
   * package.json, all landing on the exact same toVersion (Dependabot's
   * "grouped update" for a version-locked family, e.g. every @nestjs/*
   * package moving together) — passed to `packdev compat --group` so the
   * sandbox pins them to match rather than testing this package in
   * isolation while its peers silently stay on the old version, which is
   * NOT what the PR actually does. Undefined for an ordinary single-package
   * bump. A grouped bump with DIFFERING target versions across packages
   * can't be expressed this way (packdev's --group pins companions to the
   * SAME version string as the primary, not to their own independent
   * target) and stays Unsupported — see extractBump()'s doc comment.
   */
  group?: string[];
}

/**
 * The SAME package bumped to the SAME target version across MULTIPLE
 * package.json files in one PR — e.g. a monorepo where @nestjs/core needs
 * bumping in both apps/gateway and apps/notifier, and Dependabot batched
 * what would normally be two separate per-app PRs into one. Distinct from
 * Bump.group (multiple DIFFERENT packages in ONE file, pinned via
 * `--group`): this is one package, tested independently once per app,
 * since packdev's compat sandbox is scoped to one app directory and can't
 * express "these two independent apps" as a single run.
 */
export interface CrossFileBump {
  kind: "cross-file";
  name: string;
  toVersion: string;
  /** One entry per affected package.json — each run through the pipeline independently and the results combined into one comment. */
  bumps: Bump[];
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
 * Returns Unsupported when zero dependencies changed, or when more than one
 * changed in a way that can't be expressed as one packdev compat run:
 * spread across more than one package.json (a monorepo can have this), or
 * within one file but landing on DIFFERING target versions (packdev's
 * `--group` can only pin companions to the SAME version as the primary
 * being tested — see the Bump.group doc comment). A same-file, same-target-
 * version grouped bump (Dependabot's "grouped update" for a version-locked
 * family, e.g. every @nestjs/* package moving to the same release together)
 * IS supported: one bump is picked as the primary and the rest become its
 * `group`.
 */
export async function extractBump(
  options: ExtractBumpOptions,
): Promise<Bump | CrossFileBump | Unsupported> {
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

  if (bumps.length === 1) {
    return bumps[0]!;
  }

  const distinctFiles = new Set(bumps.map((b) => b.packageJsonPath));
  const distinctToVersions = new Set(bumps.map((b) => b.toVersion));
  const distinctNames = new Set(bumps.map((b) => b.name));

  if (distinctFiles.size === 1 && distinctToVersions.size === 1) {
    // Deterministic primary selection (sorted by name), not insertion
    // order, so the same PR always resolves to the same primary/group
    // split regardless of how package.json happened to list its deps.
    const sorted = [...bumps].sort((a, b) => a.name.localeCompare(b.name));
    const [primary, ...companions] = sorted;
    return { ...primary!, group: companions.map((c) => c.name) };
  }

  // The SAME package, SAME target version, one bump per distinct file —
  // e.g. @nestjs/core -> 11.2.3 in both apps/gateway and apps/notifier.
  // Requires exactly one bump per file: a file that ALSO has its own
  // internal multi-package group combined with cross-file duplication is
  // too compound a shape for v1 and stays Unsupported below.
  if (distinctNames.size === 1 && distinctToVersions.size === 1 && bumps.length === distinctFiles.size) {
    return { kind: "cross-file", name: bumps[0]!.name, toVersion: bumps[0]!.toVersion, bumps };
  }

  const reason =
    distinctFiles.size > 1
      ? `Grouped update: ${bumps.length} packages bumped across ${distinctFiles.size} package.json files in one PR`
      : `Grouped update: ${bumps.length} packages bumped to DIFFERING target versions in one PR — ` +
        "packdev's --group can only pin companions to the same version as the primary being tested";
  return { kind: "unsupported", reason, bumps };
}

export function isUnsupported(
  result: Bump | CrossFileBump | Unsupported,
): result is Unsupported {
  return "kind" in result && result.kind === "unsupported";
}

export function isCrossFileBump(
  result: Bump | CrossFileBump | Unsupported,
): result is CrossFileBump {
  return "kind" in result && result.kind === "cross-file";
}
