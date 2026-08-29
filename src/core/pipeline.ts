import path from "node:path";

import { extractBump, isUnsupported, type Bump, type Unsupported } from "./extractBump.js";
import { prepareWorkspace } from "./prepareWorkspace.js";
import { runCompat } from "./runCompat.js";
import { runApiDiff } from "./runApiDiff.js";
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
 * access. See src/adapters/github-action/octokitOps.ts for the real
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
  testCommand: string;
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
  brain?: Brain | undefined;
}

export type RunGithubPipelineResult =
  | { status: "skipped-actor"; actor: string }
  | { status: "unsupported-bump"; bump: Unsupported }
  | { status: "static-incompatible"; bump: Bump; apiDiff: ApiDiffReport }
  | { status: "verdict"; bump: Bump; verdict: Verdict; merged: boolean };

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

function checkTitleFor(verdict: Verdict, bump: Bump): string {
  return `${bump.name} ${bump.fromVersion} → ${bump.toVersion}: ${verdict.kind}`;
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
  const allowedActors = options.allowedActors ?? DEFAULT_ALLOWED_ACTORS;
  if (!allowedActors.includes(options.actor)) {
    return { status: "skipped-actor", actor: options.actor };
  }

  const bump = await extractBump({
    repoDir: options.repoDir,
    baseRef: options.baseRef,
    headRef: options.headRef,
    ...(options.packageJsonPath ? { packageJsonPath: options.packageJsonPath } : {}),
  });

  if (isUnsupported(bump)) {
    const body =
      bump.bumps.length > 0
        ? `${COMMENT_MARKER}\n### packdev compat — ⏭️ Skipped\n\n${bump.reason}: ${bump.bumps
            .map((b) => `\`${b.name}\` ${b.fromVersion} → ${b.toVersion}`)
            .join(", ")}.\n\nNot supported in v1 — this PR bumps more than one package, and guessing which one to test would produce a verdict that doesn't answer the PR.`
        : `${COMMENT_MARKER}\n### packdev compat — ⏭️ Skipped\n\n${bump.reason}.`;

    await options.github.upsertComment({ marker: COMMENT_MARKER, body });
    await options.github.createCheckRun({
      name: "packdev compat",
      conclusion: "neutral",
      title: "Skipped — unsupported bump shape",
      summary: bump.reason,
    });

    return { status: "unsupported-bump", bump };
  }

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

  type CompatStepResult =
    | { kind: "static-incompatible"; apiDiff: ApiDiffReport }
    | { kind: "verdict"; verdict: Verdict };

  let stepResult: CompatStepResult;
  try {
    // Static, no install — cheap enough to always run first. Only skips
    // the expensive sandboxed compat run on a CONFIDENT negative: a symbol
    // the app statically imports is missing from the candidate's exports,
    // AND no dynamic/namespace usage exists that could have hidden the
    // real export list (hasDynamicUsage true, or a tri-state null
    // apiCompatible, both fall through to the real compat run unchanged —
    // see docs/architecture.md).
    const apiDiffResult = await runApiDiff({
      appDir,
      packageName: bump.name,
      toVersion: bump.toVersion,
    });
    const candidateEntry = apiDiffResult.report.versions.find(
      (v) => v.version === bump.toVersion,
    );
    const confidentNegative =
      candidateEntry?.apiCompatible === false && !apiDiffResult.report.hasDynamicUsage;

    if (confidentNegative) {
      stepResult = { kind: "static-incompatible", apiDiff: apiDiffResult.report };
    } else {
      const result = await runCompat({
        appDir,
        packageName: bump.name,
        versions: [bump.toVersion],
        testCommand: options.testCommand,
        // Duplicate-copy regressions (DI singletons, instanceof checks) are a
        // real, distinct failure mode from an incompatible API — --check-dupes
        // surfaces them as dupesRegression on the report (already rendered
        // verbatim by report.ts). --seed-lockfile is required for accurate
        // nested-fork detection: a fresh solve re-flattens away duplicates a
        // real install would keep. Costs nothing extra: dupes are checked
        // against installs compat already performs.
        extraArgs: ["--check-dupes", "--seed-lockfile"],
      });
      stepResult = { kind: "verdict", verdict: interpret(result.report, result.exitCode) };
    }
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
