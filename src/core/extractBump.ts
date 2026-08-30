import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import semver from "semver";

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

/**
 * More than one package bumped in the SAME package.json to DIFFERING
 * target versions — e.g. a manually-authored or custom-agent-authored PR
 * (not Dependabot's own "grouped update", which always shares one target
 * version — see Bump.group) that bumps express AND is-number to their own
 * independent latest. packdev's `--group` can only pin companions to the
 * SAME version as the primary being tested, so there's no single sandbox
 * state that represents this PR — each bump is tested in ISOLATION
 * instead (holding every other package at its pre-bump version, which
 * `prepareWorkspace`'s base-ref checkout already gives us for free), plus
 * by default one COMBINED run against the PR's real head state to catch
 * an interaction bug two individually-fine bumps could still cause. See
 * runIndependentBumpsStep in pipeline.ts.
 */
export interface IndependentBumps {
  kind: "independent";
  packageJsonPath: string;
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
 * A dependency specifier that isn't a registry version/range and
 * therefore isn't something `packdev compat` can test candidate versions
 * of. Delegates to semver.validRange rather than a prefix blacklist: a
 * real, valid package.json can name a dist-tag ("latest", "next", "beta")
 * instead of a version/range, which isn't caught by the workspace:/file:/
 * git/http(s) prefix checks the previous blacklist had, and semver's own
 * range parser rejects those the same way it rejects "workspace:*" — one
 * check covers both cases instead of maintaining two divergent lists.
 * Verified: semver.validRange("latest"/"next") -> null,
 * semver.validRange("workspace:*") -> null, semver.validRange("^22.0.0")
 * -> a real range.
 *
 * A bare "*" is a special case kept as an explicit exclusion (caught by a
 * Copilot review of this exact change): semver.validRange("*") returns a
 * genuinely valid range (matches any version), so it isn't rejected the
 * way dist-tags are — but "*" means "no real constraint," not a
 * meaningful bump target, and toConcreteVersion("*") would resolve to
 * the nonsensical "0.0.0" via minVersion() (confirmed) rather than
 * anything the app's package.json actually intended.
 */
function isRegistrySpecifier(spec: string): boolean {
  const trimmed = spec.trim();
  return trimmed !== "*" && semver.validRange(trimmed) !== null;
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
 * Real Dependabot PRs frequently bump a RANGE specifier, not just an exact
 * pin (e.g. "^22.0.0" -> "^22.20.1" for a caret-ranged devDependency,
 * extremely common — most devDependencies use "^"/"~", not exact pins).
 * packdev's own --versions/--range flags need a concrete version, not a
 * range: passed through unnormalized, packdev rejects it outright
 * (confirmed: `packdev compat pkg --versions "^22.20.1"` returns
 * `{"success":false,"error":"Error: Invalid version(s): ^22.20.1"}`, an
 * error-shaped JSON with no `versions` field at all — silently NOT a
 * CompatReport, which used to crash interpret()'s candidatesOf() on
 * `.filter` of undefined; see runCompat.ts's defensive guard against that
 * shape too). semver.minVersion() resolves a range to the exact version
 * Dependabot actually intends here — for a bump target this is always the
 * new minimum of the range, never a real ambiguity ("^22.20.1" means
 * "resolves to 22.20.1 right now"). Bump.toVersion/fromVersion are this
 * concrete form everywhere downstream — report/comment text, api-diff,
 * compat — not the raw package.json specifier, so every version
 * comparison against packdev's own (always-concrete) responses stays
 * consistent.
 */
function toConcreteVersion(spec: string): string {
  // isRegistrySpecifier (called on both from/to before this ever runs)
  // already rejects anything semver.validRange can't parse, so this
  // shouldn't throw in practice — the try/catch is defense-in-depth
  // against a semver edge case neither of us has tested, not the primary
  // guard. Previously this had NO guard at all and crashed uncaught on
  // a dist-tag specifier ("latest"/"next"/"beta") before
  // isRegistrySpecifier was taught to reject those too — confirmed live,
  // took down the whole Action run with no PR comment, no check run.
  try {
    const resolved = semver.minVersion(spec);
    return resolved ? resolved.version : spec;
  } catch {
    return spec;
  }
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
      bumps.push({
        name,
        fromVersion: toConcreteVersion(fromVersion),
        toVersion: toConcreteVersion(toVersion),
        section,
        packageJsonPath,
      });
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
 * Returns Unsupported only when zero dependencies changed, or when more
 * than one changed spread across more than one package.json (a monorepo
 * can have this — too compound a shape for v1). Within one file: a
 * same-target-version grouped bump (Dependabot's "grouped update" for a
 * version-locked family, e.g. every @nestjs/* package moving to the same
 * release together) picks one bump as the primary and the rest become its
 * `group`; a DIFFERING-target-version grouped bump (not something
 * Dependabot's own grouping produces, but a custom actor/agent-authored PR
 * can) returns IndependentBumps instead — see its doc comment.
 */
export async function extractBump(
  options: ExtractBumpOptions,
): Promise<Bump | CrossFileBump | IndependentBumps | Unsupported> {
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

  // Same file, differing target versions — no single sandbox state
  // represents this PR (see IndependentBumps doc comment), but each bump
  // CAN be tested in isolation plus a combined run, so this is supported,
  // not skipped.
  if (distinctFiles.size === 1) {
    return { kind: "independent", packageJsonPath: bumps[0]!.packageJsonPath, bumps };
  }

  return {
    kind: "unsupported",
    reason: `Grouped update: ${bumps.length} packages bumped across ${distinctFiles.size} package.json files in one PR`,
    bumps,
  };
}

export function isUnsupported(
  result: Bump | CrossFileBump | IndependentBumps | Unsupported,
): result is Unsupported {
  return "kind" in result && result.kind === "unsupported";
}

export function isCrossFileBump(
  result: Bump | CrossFileBump | IndependentBumps | Unsupported,
): result is CrossFileBump {
  return "kind" in result && result.kind === "cross-file";
}

export function isIndependentBumps(
  result: Bump | CrossFileBump | IndependentBumps | Unsupported,
): result is IndependentBumps {
  return "kind" in result && result.kind === "independent";
}
