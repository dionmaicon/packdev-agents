import type {
  CompatReport,
  CompatVersionResult,
  TestHarnessCaveat,
} from "./packdevTypes.js";
import { PACKDEV_EXIT_CODE } from "./packdevTypes.js";

export type VerdictKind =
  | "NO_CONTROL"
  | "HARNESS_BROKEN"
  | "INSTALL_FAILED"
  | "NOTHING_TESTED"
  | "INCOMPATIBLE"
  | "PASSED_WEAK"
  | "PASSED";

interface VerdictBase {
  kind: VerdictKind;
  report: CompatReport;
}

/** No control ever ran (no node_modules install present). Our infra failed, not the bump. */
export interface NoControlVerdict extends VerdictBase {
  kind: "NO_CONTROL";
}

/** The control (currently-installed version) didn't pass. The app's own test harness is broken. */
export interface HarnessBrokenVerdict extends VerdictBase {
  kind: "HARNESS_BROKEN";
}

/** A candidate's sandboxed install itself failed, before any test ran. Not evidence of incompatibility. */
export interface InstallFailedVerdict extends VerdictBase {
  kind: "INSTALL_FAILED";
  failedVersions: CompatVersionResult[];
}

/** Every candidate came back SKIPPED (or there were none to test). Nothing was determined. */
export interface NothingTestedVerdict extends VerdictBase {
  kind: "NOTHING_TESTED";
}

/** At least one candidate failed its real test run. */
export interface IncompatibleVerdict extends VerdictBase {
  kind: "INCOMPATIBLE";
  failedVersions: CompatVersionResult[];
}

/** All candidates passed, but the app's own test command has a structural caveat attached. */
export interface PassedWeakVerdict extends VerdictBase {
  kind: "PASSED_WEAK";
  candidates: CompatVersionResult[];
  caveats: TestHarnessCaveat[];
}

/** All candidates passed cleanly. The only auto-merge-eligible verdict. */
export interface PassedVerdict extends VerdictBase {
  kind: "PASSED";
  candidates: CompatVersionResult[];
}

export type Verdict =
  | NoControlVerdict
  | HarnessBrokenVerdict
  | InstallFailedVerdict
  | NothingTestedVerdict
  | IncompatibleVerdict
  | PassedWeakVerdict
  | PassedVerdict;

/** Only PASSED is safe for an auto-merge policy to act on without a human. */
export function isAutoMergeEligible(verdict: Verdict): verdict is PassedVerdict {
  return verdict.kind === "PASSED";
}

function candidatesOf(report: CompatReport): CompatVersionResult[] {
  const controlVersion = report.control?.version;
  return report.versions.filter((v) => v.version !== controlVersion);
}

/**
 * Turns a packdev CompatReport into a Verdict. A PURE function, explicitly
 * NOT a zero/nonzero exit-code check — see docs/architecture.md "core /
 * interpret". Precedence (highest first): NO_CONTROL > HARNESS_BROKEN >
 * INSTALL_FAILED > NOTHING_TESTED > INCOMPATIBLE > PASSED_WEAK > PASSED.
 *
 * HARNESS_BROKEN and INSTALL_FAILED must never be reported as the bump
 * being incompatible. NOTHING_TESTED must never be reported as a pass.
 */
export function interpret(report: CompatReport, exitCode: number): Verdict {
  if (report.control === null) {
    return { kind: "NO_CONTROL", report };
  }

  if (report.controlFailed) {
    return { kind: "HARNESS_BROKEN", report };
  }

  const candidates = candidatesOf(report);

  const installFailed = candidates.filter((v) => v.status === "INSTALL_FAILED");
  if (installFailed.length > 0) {
    return { kind: "INSTALL_FAILED", report, failedVersions: installFailed };
  }

  const nothingTested =
    exitCode === PACKDEV_EXIT_CODE.NOTHING_TESTED ||
    candidates.length === 0 ||
    candidates.every((v) => v.status === "SKIPPED");
  if (nothingTested) {
    return { kind: "NOTHING_TESTED", report };
  }

  const failed = candidates.filter((v) => v.status === "FAILED");
  if (failed.length > 0) {
    return { kind: "INCOMPATIBLE", report, failedVersions: failed };
  }

  // Every remaining candidate is PASSED (INSTALL_FAILED/SKIPPED/FAILED all
  // handled above).
  if (report.testCommandCaveats.length > 0) {
    return {
      kind: "PASSED_WEAK",
      report,
      candidates,
      caveats: report.testCommandCaveats,
    };
  }

  return { kind: "PASSED", report, candidates };
}
