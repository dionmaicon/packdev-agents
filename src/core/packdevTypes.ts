/**
 * Report shapes mirrored from packdev's own TS source (src/compat.ts,
 * src/index.ts), pinned against packdev 0.4.3. packdev ships no versioned
 * JSON schema — these interfaces ARE the contract. Re-verify against
 * packdev's source on any packdev bump. See docs/architecture.md.
 */

export type CompatStatus = "PASSED" | "FAILED" | "INSTALL_FAILED" | "SKIPPED";

export interface DupesRegressionEntry {
  package: string;
  controlCopies: number;
  candidateCopies: number;
}

export interface ConsumerTestResult {
  dir: string;
  name: string | null;
  status: "PASSED" | "FAILED";
  exitCode: number | null;
  output?: string | undefined;
}

/**
 * Best-effort counts scraped from the test runner's own summary output
 * (packdev 0.4.3+). `undefined` — never a false zero — when no known
 * runner format could be parsed, so a missing count is unambiguously
 * "couldn't tell" rather than "nothing ran".
 */
export interface TestCounts {
  testsRun: number;
  testsFailed: number;
  /** Which runner's output format was matched, e.g. "node-test", "jest", "vitest", "mocha". */
  source: string;
}

export interface CompatVersionResult {
  version: string;
  status: CompatStatus;
  exitCode: number | null;
  durationMs: number;
  output?: string | undefined;
  lockfileHash: string | null;
  lockfileSnapshotPath: string | null;
  dupeCounts?: Record<string, number> | undefined;
  dupesRegression?: DupesRegressionEntry[] | undefined;
  esmMismatch?: string | undefined;
  consumers?: ConsumerTestResult[] | undefined;
  testCounts?: TestCounts | undefined;
}

export type TestHarnessCaveatCode =
  | "TRANSPILE_ONLY"
  | "TYPE_CHECK_ONLY"
  /**
   * As of packdev 0.4.3 this fires DYNAMICALLY too — when a run exits 0
   * having reported zero tests executed, not just when the command string
   * statically looks test-less. That is the exact silent-false-PASSED
   * shape this repo hit live (dionmaicon/packdev#6), and interpret() maps
   * any caveat to PASSED_WEAK, which is never auto-merge eligible.
   */
  | "PASS_WITH_NO_TESTS"
  /** packdev 0.4.3+: --ignore-install-scripts couldn't be honored (an unresolvable yarn generation), surfaced instead of silently no-op'ing. */
  | "IGNORE_SCRIPTS_UNSUPPORTED";

export interface TestHarnessCaveat {
  code: TestHarnessCaveatCode;
  severity: "warning";
  message: string;
}

export interface CompatReport {
  package: string;
  minimumCompatibleVersion: string | null;
  recommendedVersion: string | null;
  nonMonotonic: boolean;
  versions: CompatVersionResult[];
  group?: string[] | undefined;
  snapshotDir: string;
  concurrency: number;
  testCommandCaveat: string | null;
  testCommandCaveats: TestHarnessCaveat[];
  /**
   * The currently-installed version, tested identically to every candidate.
   * Resolved from node_modules at appDir, NEVER from --versions/--range —
   * null when no node_modules install is present. A null control means no
   * harness-sanity check ran at all; do not treat it as a healthy run. See
   * docs/architecture.md "The control problem".
   */
  control: CompatVersionResult | null;
  controlFailed: boolean;
  sandboxMode: "hermetic" | "workspace";
  packageManager: string;
  seededLockfile: boolean;
  lockfileSeedNote: string | null;
  fanOutConsumers: string[];
}

export interface CompatBisectReport extends CompatReport {
  bisected: true;
  testedVersionCount: number;
  totalVersionCount: number;
  fellBackToLinearScan: boolean;
}

export function isCompatBisectReport(
  report: CompatReport | CompatBisectReport,
): report is CompatBisectReport {
  return "bisected" in report;
}

export interface ApiDiffVersionResult {
  version: string;
  /**
   * Tri-state: null means "could not verify" (types-package fallback,
   * unresolved barrel re-exports) and must never be treated as either a
   * pass or a failure.
   */
  apiCompatible: boolean | null;
  missingSymbols: string[];
  unresolvedSymbols: string[];
  exportCount: number;
  typesSource: "bundled" | "types-package" | "none";
  typesPackage?: string | undefined;
  typesPackageVersionMismatch?: boolean | undefined;
  esmOnlyAdvisory?: string | undefined;
}

export interface ApiDiffReport {
  package: string;
  range: string;
  usedSymbols: string[];
  /**
   * True when the app uses the package via a namespace import or bare
   * require() that the static scan cannot enumerate exact symbols for —
   * usedSymbols under-reports in this case; defer to compat.
   */
  hasDynamicUsage: boolean;
  minimumCompatibleVersion: string | null;
  recommendedVersion: string | null;
  versions: ApiDiffVersionResult[];
}

/** packdev's stable exit codes (src/index.ts). */
export const PACKDEV_EXIT_CODE = {
  SUCCESS: 0,
  GENERIC_ERROR: 1,
  CONFIG_NOT_FOUND: 2,
  PACKAGE_JSON_NOT_FOUND: 3,
  PACKAGE_NOT_INSTALLED: 4,
  DUPLICATE_FOUND: 5,
  NOTHING_TESTED: 6,
  COMPAT_FAILED: 7,
} as const;

export type PackdevExitCode =
  (typeof PACKDEV_EXIT_CODE)[keyof typeof PACKDEV_EXIT_CODE];
