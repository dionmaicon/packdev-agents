import path from "node:path";

import {
  extractBump,
  isUnsupported,
  isCrossFileBump,
  isIndependentBumps,
  type Bump,
  type CrossFileBump,
  type IndependentBumps,
  type Unsupported,
} from "./extractBump.js";
import { prepareWorkspace, type Workspace } from "./prepareWorkspace.js";
import { runCompat } from "./runCompat.js";
import { runApiDiff } from "./runApiDiff.js";
import { runCombinedTest } from "./runCombinedTest.js";
import { interpret, isAutoMergeEligible, type Verdict } from "./interpret.js";
import { render, renderStaticIncompatible } from "./report.js";
import { renderWithBrain, type Brain } from "./brain.js";
import type { ApiDiffReport } from "./packdevTypes.js";

export const DEFAULT_ALLOWED_ACTORS = ["dependabot[bot]", "renovate[bot]"];

export type CheckConclusion = "success" | "neutral" | "failure";

export interface CommentInput {
  /** Identifies this action's own comment so re-runs update it instead of piling up new ones. */
  marker: string;
  body: string;
}

export interface CheckRunInput {
  name: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
}

/**
 * Everything that actually talks to GitHub, behind one small interface —
 * kept separate from the pipeline logic so the pipeline can be tested
 * against a real git repo and a real packdev run without any GitHub API
 * access. See src/adapters/shared/octokitOps.ts for the real
 * implementation and main.ts for how it's wired up.
 */
export interface GitHubOps {
  upsertComment(input: CommentInput): Promise<void>;
  createCheckRun(input: CheckRunInput): Promise<void>;
  mergePullRequest(): Promise<void>;
}

export const COMMENT_MARKER = "<!-- packdev-agents:compat-check -->";

export interface RunGithubPipelineOptions {
  /** A git checkout containing both baseRef and headRef. */
  repoDir: string;
  baseRef: string;
  /** Usually "HEAD" — the checkout is expected to already be at the PR's head commit. */
  headRef: string;
  /** The PR author's login, e.g. from the pull_request webhook payload's `pull_request.user.login`. */
  actor: string;
  /**
   * Exactly one of testCommand/testScript is required — see
   * runCompat.ts's RunCompatOptions doc comment for why testScript is
   * usually the better choice (it's what lets packdev's own harness-
   * caveat detection actually see the app's real test script, instead of
   * being hidden behind an "npm test" indirection).
   */
  testCommand?: string | undefined;
  testScript?: string | undefined;
  github: GitHubOps;
  /**
   * Optional, and usually not needed: an explicit override narrowing
   * extractBump to ONE specific package.json, relative to repoDir. Without
   * it (the default), extractBump auto-discovers whichever package.json
   * actually changed between baseRef and headRef — the right behavior for
   * a monorepo with more than one independently-Dependabot-tracked
   * workspace member, since each gets its own PR touching a different
   * file. Whichever file the bump is found in (bump.packageJsonPath) is
   * what determines the compat sandbox's working directory below — this
   * option only constrains *which* file extractBump is allowed to look at.
   */
  packageJsonPath?: string | undefined;
  /** Defaults to dependabot[bot] and renovate[bot]. Defense-in-depth: the caller workflow should already gate on actor at the job level. */
  allowedActors?: string[] | undefined;
  /** Only takes effect when the verdict is PASSED. Off by default — merging is the user's call. */
  autoMerge?: boolean | undefined;
  /**
   * Only relevant for an IndependentBumps PR (see extractBump.ts): whether
   * to run one extra check against the PR's real combined state (every
   * bump applied at once, as actually committed), on top of testing each
   * bump in isolation. Defaults to true — an interaction bug between two
   * individually-fine bumps is a real correctness gap isolation alone
   * cannot see. Set to false to cap cost at N isolated runs instead of
   * N+1, e.g. for a high-traffic repo where that extra sandbox run isn't
   * worth it.
   */
  testCombinedBump?: boolean | undefined;
  brain?: Brain | undefined;
}

/**
 * One IndependentBumps PR's combined-state result (see extractBump.ts).
 * Distinct from CompatStepResult: no packdev sandbox, no control
 * comparison — a plain pass/fail against the PR's real head. "error"
 * mirrors runCombinedTest.ts's own distinction: a timeout/signal-kill/
 * spawn-failure says nothing reliable about the bumps themselves, so it
 * is deliberately NOT the same as "failed" for rendering purposes (see
 * renderCombined), even though both block auto-merge the same way —
 * an inconclusive harness result is never good enough to merge on either.
 */
export type CombinedResult =
  | { kind: "skipped" }
  | { kind: "passed"; output: string }
  | { kind: "failed"; output: string; exitCode: number }
  | { kind: "error"; message: string; output: string };

/** One package.json's outcome within a cross-file bump (see extractBump.ts's CrossFileBump). */
export type CompatStepResult =
  | { kind: "static-incompatible"; apiDiff: ApiDiffReport }
  | { kind: "verdict"; verdict: Verdict };

export type RunGithubPipelineResult =
  | { status: "skipped-actor"; actor: string }
  | { status: "unsupported-bump"; bump: Unsupported }
  | { status: "static-incompatible"; bump: Bump; apiDiff: ApiDiffReport }
  | { status: "verdict"; bump: Bump; verdict: Verdict; merged: boolean }
  | {
      status: "cross-file-verdict";
      bump: CrossFileBump;
      results: Array<{ bump: Bump; step: CompatStepResult }>;
      merged: boolean;
    }
  | {
      status: "independent-verdict";
      bump: IndependentBumps;
      results: Array<{ bump: Bump; step: CompatStepResult }>;
      combined: CombinedResult;
      merged: boolean;
    };

/** Exported so main.ts can decide whether to fail the Action step itself using the same mapping as the check run conclusion, instead of duplicating the switch. */
export function checkConclusionFor(verdict: Verdict): CheckConclusion {
  switch (verdict.kind) {
    case "PASSED":
      return "success";
    case "PASSED_WEAK":
      return "neutral";
    default:
      // NO_CONTROL, HARNESS_BROKEN, INSTALL_FAILED, NOTHING_TESTED,
      // INCOMPATIBLE: none of these should be silently green. Marking all
      // of them "failure" blocks GitHub's own merge-checks gate, which is
      // the safety property that matters — nothing merges unless the
      // verdict is genuinely PASSED.
      return "failure";
  }
}

/** Worst-of-all: any single failing step fails the whole cross-file result; a step-level conclusion is only as good as its weakest member. Exported so main.ts's cross-file/independent-verdict output logging uses this instead of its own copy — see checkConclusionForCrossFile/checkConclusionForIndependent below, which are the actual public surface for that. */
export function checkConclusionForStep(step: CompatStepResult): CheckConclusion {
  return step.kind === "static-incompatible" ? "failure" : checkConclusionFor(step.verdict);
}

/** "error" (harness/timeout/spawn problem) blocks the same as "failed" — see CombinedResult's doc comment for why. */
export function checkConclusionForCombined(combined: CombinedResult): CheckConclusion {
  return combined.kind === "failed" || combined.kind === "error" ? "failure" : "success";
}

export function worstConclusion(conclusions: CheckConclusion[]): CheckConclusion {
  if (conclusions.includes("failure")) return "failure";
  if (conclusions.includes("neutral")) return "neutral";
  return "success";
}

/**
 * The ONE place that computes a cross-file bump's overall conclusion —
 * previously main.ts had its own copy of this exact logic (worked, but
 * only by staying manually in sync; a future change to the aggregation
 * rule had no compiler-enforced reason to update main.ts too).
 */
export function checkConclusionForCrossFile(results: Array<{ step: CompatStepResult }>): CheckConclusion {
  return worstConclusion(results.map((r) => checkConclusionForStep(r.step)));
}

/** Same reasoning as checkConclusionForCrossFile, for IndependentBumps. */
export function checkConclusionForIndependent(
  results: Array<{ step: CompatStepResult }>,
  combined: CombinedResult,
): CheckConclusion {
  return worstConclusion([...results.map((r) => checkConclusionForStep(r.step)), checkConclusionForCombined(combined)]);
}

function checkTitleFor(verdict: Verdict, bump: Bump): string {
  const groupSuffix = bump.group && bump.group.length > 0 ? ` (+${bump.group.length} grouped)` : "";
  return `${bump.name}${groupSuffix} ${bump.fromVersion} → ${bump.toVersion}: ${verdict.kind}`;
}

/**
 * True only for a CONFIDENT, NEW regression: a symbol missing from the
 * candidate's exports, with no dynamic/namespace usage that could have
 * hidden the real export list, AND the control does NOT confidently show
 * the same failure already.
 *
 * That last condition is the fix for a real bug, found live: a symbol
 * that's ALSO missing at the control (currently-installed) version is a
 * PRE-EXISTING app issue, not a regression this bump introduced — is-odd
 * has never exported a named "isOdd" at any version, and a real test PR
 * bumping 3.0.0 -> 3.0.1 was reported "the bump is incompatible with this
 * app", which was false: the app was equally broken before the bump.
 * Mirrors HARNESS_BROKEN's precedence in interpret() (control fails ->
 * never blame the candidate), which this static path had no equivalent
 * of until this fix. `controlEntry?.apiCompatible !== false` deliberately
 * treats BOTH `true` (control genuinely has the symbol) and the
 * unverifiable tri-state `null` as "not confidently broken already" —
 * only a CONFIRMED `false` control result rules this out, since a `null`
 * control can't be used to excuse a confident candidate failure either.
 * Exported standalone (no process spawning needed) so this exact
 * regression can be pinned down with plain fixture objects.
 */
export function isConfidentStaticRegression(
  candidateEntry: { apiCompatible: boolean | null } | undefined,
  candidateHasDynamicUsage: boolean,
  controlEntry: { apiCompatible: boolean | null } | undefined,
): boolean {
  return (
    candidateEntry?.apiCompatible === false &&
    !candidateHasDynamicUsage &&
    controlEntry?.apiCompatible !== false
  );
}

/**
 * The static-prefilter-then-compat logic for ONE bump against an already-
 * prepared app directory. Pulled out of runGithubPipeline so a cross-file
 * bump (the SAME package bumped in multiple independent apps — see
 * extractBump.ts's CrossFileBump) can run this once per affected app
 * within a single shared workspace checkout, instead of duplicating the
 * whole prepareWorkspace-through-interpret sequence per app.
 */
async function runCompatStep(
  appDir: string,
  bump: Bump,
  test: { testCommand?: string | undefined; testScript?: string | undefined },
): Promise<CompatStepResult> {
  // Static, no install — cheap enough to always run first. Only skips the
  // expensive sandboxed compat run on a CONFIDENT, NEW regression (see
  // isConfidentStaticRegression above) — never on a pre-existing issue the
  // control already has, and never with dynamic/namespace usage in play
  // (hasDynamicUsage true, or a tri-state null apiCompatible, both fall
  // through to the real compat run unchanged — see docs/architecture.md).
  // Skipped entirely for a grouped bump: api-diff has no --group
  // equivalent, and checking only the primary package's static usage in
  // isolation doesn't represent what the PR actually changed (its
  // companions).
  if (!bump.group) {
    const [candidateResult, controlResult] = await Promise.all([
      runApiDiff({ appDir, packageName: bump.name, toVersion: bump.toVersion }),
      runApiDiff({ appDir, packageName: bump.name, toVersion: bump.fromVersion }),
    ]);
    const candidateEntry = candidateResult.report.versions.find((v) => v.version === bump.toVersion);
    const controlEntry = controlResult.report.versions.find((v) => v.version === bump.fromVersion);
    if (isConfidentStaticRegression(candidateEntry, candidateResult.report.hasDynamicUsage, controlEntry)) {
      return { kind: "static-incompatible", apiDiff: candidateResult.report };
    }
  }

  const result = await runCompat({
    appDir,
    packageName: bump.name,
    versions: [bump.toVersion],
    ...(test.testScript ? { testScript: test.testScript } : { testCommand: test.testCommand }),
    extraArgs: [
      // Duplicate-copy regressions (DI singletons, instanceof checks) are a
      // real, distinct failure mode from an incompatible API —
      // --check-dupes surfaces them as dupesRegression on the report
      // (already rendered verbatim by report.ts). --seed-lockfile is
      // required for accurate nested-fork detection: a fresh solve
      // re-flattens away duplicates a real install would keep. Costs
      // nothing extra: dupes are checked against installs compat already
      // performs.
      "--check-dupes",
      "--seed-lockfile",
      // A grouped bump (same file, same target version — see
      // extractBump.ts) pins its companions to bump.toVersion too, so the
      // sandbox actually reflects what the PR changed instead of testing
      // the primary alone while its peers silently stay old.
      ...(bump.group && bump.group.length > 0 ? ["--group", bump.group.join(",")] : []),
    ],
  });
  return { kind: "verdict", verdict: interpret(result.report, result.exitCode) };
}

/** Renders one CompatStepResult's body — shared between the single-bump and cross-file-per-app comment paths. */
function renderStep(step: CompatStepResult, bump: Bump): string {
  if (step.kind === "static-incompatible") return renderStaticIncompatible(bump, step.apiDiff);
  return render(step.verdict);
}

function renderCombined(combined: CombinedResult): string {
  switch (combined.kind) {
    case "skipped":
      return "_Combined run skipped (`test-combined-bump: false`) — each bump above was only tested in isolation; an interaction between them wouldn't be caught by that alone._";
    case "passed":
      return "✅ All bumps together, exactly as this PR applies them, pass the real test suite.";
    case "failed":
      return (
        `❌ All bumps together FAIL the real test suite (exit ${combined.exitCode}) — even if every bump ` +
        "passed in isolation above, this specific combination does not work.\n\n```\n" +
        `${combined.output.slice(0, 4000)}\n\`\`\``
      );
    case "error":
      return (
        `⚠️ The combined run couldn't produce a real result: ${combined.message}. This is a harness/` +
        "environment problem, not a signal about the bumps themselves — treated as inconclusive, not a " +
        `failure to blame on this combination.\n\n\`\`\`\n${combined.output.slice(0, 4000)}\n\`\`\``
      );
  }
}

/**
 * Runs an IndependentBumps PR (see extractBump.ts): each bump tested in
 * isolation against a SHARED base-ref checkout — prepareWorkspace's
 * control guard means that checkout already holds every OTHER package at
 * its pre-bump version, so isolation needs no extra work beyond calling
 * runCompatStep once per bump — plus, unless disabled, one more run
 * against a SEPARATE head-ref checkout (every bump applied at once, as
 * the PR actually committed it) to catch an interaction bug isolation
 * structurally cannot see.
 */
async function runIndependentBumpsStep(
  options: RunGithubPipelineOptions,
  bumpResult: IndependentBumps,
): Promise<{ results: Array<{ bump: Bump; step: CompatStepResult }>; combined: CombinedResult }> {
  const workspace = await prepareWorkspace({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    packageJsonPath: bumpResult.packageJsonPath,
  });

  let results: Array<{ bump: Bump; step: CompatStepResult }>;
  try {
    const appDir = path.join(workspace.dir, path.dirname(bumpResult.packageJsonPath));
    results = await Promise.all(
      bumpResult.bumps.map(async (bump) => ({
        bump,
        step: await runCompatStep(appDir, bump, { testCommand: options.testCommand, testScript: options.testScript }),
      })),
    );
  } finally {
    await workspace.cleanup();
  }

  const includeCombined = options.testCombinedBump ?? true;
  let combined: CombinedResult = { kind: "skipped" };
  if (includeCombined) {
    const headWorkspace = await prepareWorkspace({
      repoDir: options.repoDir,
      baseRef: options.headRef,
      packageJsonPath: bumpResult.packageJsonPath,
    });
    try {
      const headAppDir = path.join(headWorkspace.dir, path.dirname(bumpResult.packageJsonPath));
      const combinedResult = await runCombinedTest({
        appDir: headAppDir,
        packageManager: headWorkspace.packageManager,
        testCommand: options.testCommand,
        testScript: options.testScript,
      });
      combined = combinedResult;
    } finally {
      await headWorkspace.cleanup();
    }
  }

  return { results, combined };
}

/**
 * Runs the full core pipeline (extractBump -> prepareWorkspace -> runCompat
 * -> interpret -> render) against a prepared git checkout and reports the
 * result through the injected GitHubOps. This is the GitHub Action's real
 * logic; main.ts is just environment/input plumbing around this function.
 */
export async function runGithubPipeline(
  options: RunGithubPipelineOptions,
): Promise<RunGithubPipelineResult> {
  if (!options.testCommand && !options.testScript) {
    throw new Error("runGithubPipeline: exactly one of testCommand/testScript is required, got neither");
  }
  if (options.testCommand && options.testScript) {
    throw new Error("runGithubPipeline: testCommand and testScript are mutually exclusive, got both");
  }

  const allowedActors = options.allowedActors ?? DEFAULT_ALLOWED_ACTORS;
  if (!allowedActors.includes(options.actor)) {
    return { status: "skipped-actor", actor: options.actor };
  }

  const bumpResult = await extractBump({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    headRef: options.headRef,
    ...(options.packageJsonPath ? { packageJsonPath: options.packageJsonPath } : {}),
  });

  if (isUnsupported(bumpResult)) {
    const body =
      bumpResult.bumps.length > 0
        ? `${COMMENT_MARKER}\n### packdev compat — ⏭️ Skipped\n\n${bumpResult.reason}: ${bumpResult.bumps
            .map((b) => `\`${b.name}\` ${b.fromVersion} → ${b.toVersion}`)
            .join(", ")}.\n\nNot supported in v1 — this PR bumps more than one package, and guessing which one to test would produce a verdict that doesn't answer the PR.`
        : `${COMMENT_MARKER}\n### packdev compat — ⏭️ Skipped\n\n${bumpResult.reason}.`;

    await options.github.upsertComment({ marker: COMMENT_MARKER, body });
    await options.github.createCheckRun({
      name: "packdev compat",
      conclusion: "neutral",
      title: "Skipped — unsupported bump shape",
      summary: bumpResult.reason,
    });

    return { status: "unsupported-bump", bump: bumpResult };
  }

  if (isCrossFileBump(bumpResult)) {
    // One shared checkout serves every affected app: prepareWorkspace
    // always installs from the whole repo root regardless of which
    // packageJsonPath is passed (see prepareWorkspace.ts) — it only uses
    // that path for package-manager detection — so there is no need to
    // check out once per app.
    const workspace = await prepareWorkspace({
      repoDir: options.repoDir,
      baseRef: options.baseRef,
      packageJsonPath: bumpResult.bumps[0]!.packageJsonPath,
    });

    let results: Array<{ bump: Bump; step: CompatStepResult }>;
    try {
      results = await Promise.all(
        bumpResult.bumps.map(async (bump) => {
          const appDir = path.join(workspace.dir, path.dirname(bump.packageJsonPath));
          const step = await runCompatStep(appDir, bump, { testCommand: options.testCommand, testScript: options.testScript });
          return { bump, step };
        }),
      );
    } finally {
      await workspace.cleanup();
    }

    const lines: string[] = [
      `### packdev compat — ${bumpResult.name} \`${bumpResult.toVersion}\` bumped across ${results.length} apps`,
      "",
    ];
    for (const { bump, step } of results) {
      lines.push(`#### \`${bump.packageJsonPath}\` (\`${bump.fromVersion}\` → \`${bump.toVersion}\`)`);
      lines.push("");
      lines.push(renderStep(step, bump));
      lines.push("");
    }
    const body = `${COMMENT_MARKER}\n${lines.join("\n")}`;

    await options.github.upsertComment({ marker: COMMENT_MARKER, body });
    const conclusion = checkConclusionForCrossFile(results);
    await options.github.createCheckRun({
      name: "packdev compat",
      conclusion,
      title: `${bumpResult.name} ${bumpResult.toVersion}: ${results.length} apps, ${conclusion}`,
      summary: body,
    });

    // Only auto-merge when EVERY affected app genuinely PASSED — one app
    // silently staying broken is not an acceptable bar just because
    // another app happened to pass.
    const allPassed = results.every((r) => r.step.kind === "verdict" && isAutoMergeEligible(r.step.verdict));
    let merged = false;
    if (options.autoMerge && allPassed) {
      await options.github.mergePullRequest();
      merged = true;
    }

    return { status: "cross-file-verdict", bump: bumpResult, results, merged };
  }

  if (isIndependentBumps(bumpResult)) {
    const { results, combined } = await runIndependentBumpsStep(options, bumpResult);

    const lines: string[] = [
      `### packdev compat — ${results.length} packages bumped to DIFFERING target versions in one PR`,
      "",
      "Each bump below is tested in isolation (every other package held at its pre-bump version) — packdev's `--group` can only pin companions to the SAME version, which doesn't apply here.",
      "",
    ];
    for (const { bump, step } of results) {
      lines.push(`#### \`${bump.name}\` \`${bump.fromVersion}\` → \`${bump.toVersion}\``);
      lines.push("");
      lines.push(renderStep(step, bump));
      lines.push("");
    }
    lines.push("#### Combined — all bumps together, as this PR actually applies them");
    lines.push("");
    lines.push(renderCombined(combined));
    const body = `${COMMENT_MARKER}\n${lines.join("\n")}`;

    await options.github.upsertComment({ marker: COMMENT_MARKER, body });

    const conclusion = checkConclusionForIndependent(results, combined);

    await options.github.createCheckRun({
      name: "packdev compat",
      conclusion,
      title: `${results.length} differing-version bumps: ${conclusion}`,
      summary: body,
    });

    // Auto-merge requires every isolated bump to genuinely pass AND (when
    // run) the combined state to not fail — a skipped combined run never
    // blocks merge on its own; that's the cost/coverage tradeoff the user
    // opted into via testCombinedBump: false.
    const allIsolatedPassed = results.every((r) => r.step.kind === "verdict" && isAutoMergeEligible(r.step.verdict));
    const combinedOk = combined.kind !== "failed" && combined.kind !== "error";
    let merged = false;
    if (options.autoMerge && allIsolatedPassed && combinedOk) {
      await options.github.mergePullRequest();
      merged = true;
    }

    return { status: "independent-verdict", bump: bumpResult, results, combined, merged };
  }

  const bump = bumpResult;

  const workspace = await prepareWorkspace({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    packageJsonPath: bump.packageJsonPath,
  });

  // The install itself runs from the workspace root (correct for real
  // npm/yarn/pnpm workspaces — that's how they're meant to be installed),
  // but packdev's compat sandbox needs to run FROM the workspace member's
  // own directory so its control resolution (node_modules-based) finds
  // that member's install, not the root's. Mirrors how a developer would
  // actually invoke `packdev compat` themselves: cd into the package, run
  // it there — packdev's own workspace-mode auto-detection still widens
  // the sandbox to the whole monorepo root when workspace:-protocol deps
  // require it, regardless of cwd. Uses bump.packageJsonPath (what
  // extractBump actually found), not options.packageJsonPath (which may
  // have been omitted entirely and left to auto-discovery).
  const appDir = path.join(workspace.dir, path.dirname(bump.packageJsonPath));

  let stepResult: CompatStepResult;
  try {
    stepResult = await runCompatStep(appDir, bump, { testCommand: options.testCommand, testScript: options.testScript });
  } finally {
    await workspace.cleanup();
  }

  if (stepResult.kind === "static-incompatible") {
    const body = renderStaticIncompatible(bump, stepResult.apiDiff);
    const commentBody = `${COMMENT_MARKER}\n${body}`;

    await options.github.upsertComment({ marker: COMMENT_MARKER, body: commentBody });
    await options.github.createCheckRun({
      name: "packdev compat",
      conclusion: "failure",
      title: `${bump.name} ${bump.fromVersion} → ${bump.toVersion}: STATIC_INCOMPATIBLE`,
      summary: body,
    });

    return { status: "static-incompatible", bump, apiDiff: stepResult.apiDiff };
  }

  const verdict = stepResult.verdict;
  const body = await renderWithBrain(verdict, options.brain);
  const commentBody = `${COMMENT_MARKER}\n${body}`;

  await options.github.upsertComment({ marker: COMMENT_MARKER, body: commentBody });
  await options.github.createCheckRun({
    name: "packdev compat",
    conclusion: checkConclusionFor(verdict),
    title: checkTitleFor(verdict, bump),
    summary: render(verdict),
  });

  let merged = false;
  if (options.autoMerge && isAutoMergeEligible(verdict)) {
    await options.github.mergePullRequest();
    merged = true;
  }

  return { status: "verdict", bump, verdict, merged };
}
