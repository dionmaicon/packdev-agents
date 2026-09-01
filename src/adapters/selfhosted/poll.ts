import { runCompatPipeline, DEFAULT_ALLOWED_ACTORS, type ForgeOps, type RunCompatPipelineResult } from "../../core/pipeline.js";
import type { Brain } from "../../core/brain.js";
import { ensureLocalClone, fetchBranch } from "./repoSync.js";
import { loadSeenState, saveSeenState } from "./state.js";
import type { OpenBotPR, PullRequestSource } from "../../providers/types.js";

export interface PollOptions {
  /** Local working copy of the target repo. Cloned on first use, fetched to update on later polls. */
  cloneDir: string;
  remoteUrl: string;
  /** "Authorization: ..." applied per git invocation, never persisted to .git/config — see repoSync.ts's authArgs and providers/types.ts's GitRemote. */
  authHeader?: string | undefined;
  /** Where seen-PR state (see state.ts) is persisted between polls/restarts. */
  statePath: string;
  /** Exactly one of testCommand/testScript is required — see runCompatPipeline's doc comment. */
  testCommand?: string | undefined;
  testScript?: string | undefined;
  prSource: PullRequestSource;
  /** Builds the ForgeOps sink for a specific PR — needs the PR number and head SHA to address comments/checks at. */
  forgeOpsFor: (pr: OpenBotPR) => ForgeOps;
  /** See RunCompatPipelineOptions.packageJsonPath — for a monorepo target, e.g. "packages/api/package.json". */
  packageJsonPath?: string | undefined;
  allowedActors?: string[] | undefined;
  autoMerge?: boolean | undefined;
  /** See RunCompatPipelineOptions.testCombinedBump. Defaults to true. */
  testCombinedBump?: boolean | undefined;
  brain?: Brain | undefined;
}

export interface ProcessedPR {
  pr: OpenBotPR;
  result: RunCompatPipelineResult;
}

export interface FailedPR {
  pr: OpenBotPR;
  error: unknown;
}

export interface PollResult {
  processed: ProcessedPR[];
  skippedAlreadySeen: OpenBotPR[];
  /**
   * PRs that threw during this cycle (fetch/git error, a real bug in the
   * pipeline, etc). Deliberately NOT included in `processed` and their
   * headSha is deliberately NOT saved as seen — see pollOnce's doc
   * comment for why that's the right call, and why this list exists
   * instead of just logging and moving on silently.
   */
  failed: FailedPR[];
}

/**
 * One polling cycle: sync the local clone, list open bot PRs, and run the
 * shared core pipeline (see docs/architecture.md) against every PR that's
 * new or has moved to a new head SHA since it was last processed. State is
 * saved after EACH PR, not once at the end — a crash partway through a
 * batch must not lose progress already made or cause already-handled PRs
 * to be reprocessed and re-commented on restart.
 *
 * Each PR is isolated in its own try/catch: previously a single throwing
 * PR (a transient git/network error, or a real bug) aborted the ENTIRE
 * pollOnce() call, silently skipping every PR after it in this cycle's
 * list — and since the failing PR's headSha was never saved, it would
 * retry and fail again in the same position next cycle, potentially
 * starving every newer PR indefinitely. A failure here is collected into
 * `failed` and processing continues with the next PR; the failing PR's
 * headSha is still deliberately not saved, so it's retried next cycle
 * (the one property worth keeping from the old behavior), but it no
 * longer blocks anyone else.
 */
export async function pollOnce(options: PollOptions): Promise<PollResult> {
  await ensureLocalClone({ cloneDir: options.cloneDir, remoteUrl: options.remoteUrl, authHeader: options.authHeader });

  const state = await loadSeenState(options.statePath);
  const allPRs = await options.prSource.listOpenBotPRs();
  const allowedActors = options.allowedActors ?? DEFAULT_ALLOWED_ACTORS;

  const processed: ProcessedPR[] = [];
  const skippedAlreadySeen: OpenBotPR[] = [];
  const failed: FailedPR[] = [];

  for (const pr of allPRs) {
    if (!allowedActors.includes(pr.actor)) continue;

    if (state[String(pr.number)] === pr.headSha) {
      skippedAlreadySeen.push(pr);
      continue;
    }

    try {
      await fetchBranch(options.cloneDir, pr.baseBranch, options.authHeader);
      await fetchBranch(options.cloneDir, pr.headBranch, options.authHeader);

      const result = await runCompatPipeline({
        repoDir: options.cloneDir,
        // Exact SHAs from the PR API response, not the branch names just
        // fetched — a branch can move between the fetch above and
        // extractBump/prepareWorkspace reading it; the SHA can't.
        baseRef: pr.baseSha,
        headRef: pr.headSha,
        actor: pr.actor,
        ...(options.testScript ? { testScript: options.testScript } : { testCommand: options.testCommand }),
        forge: options.forgeOpsFor(pr),
        allowedActors: options.allowedActors,
        autoMerge: options.autoMerge,
        brain: options.brain,
        ...(options.packageJsonPath ? { packageJsonPath: options.packageJsonPath } : {}),
        ...(options.testCombinedBump !== undefined ? { testCombinedBump: options.testCombinedBump } : {}),
      });

      // Mutate `state` and persist BEFORE pushing to `processed` — if
      // saveSeenState throws (a transient disk error), the mutation is
      // rolled back before the catch below runs. Getting this order
      // backwards was a real bug caught in review: with the mutation and
      // push happening first, a failed save still left the in-memory
      // `state` object holding this PR's new SHA, so a LATER PR's
      // successful save would serialize that stale mutation to disk
      // anyway — silently marking a PR "seen" despite its own save
      // failing, so it would never actually retry. The old ordering also
      // let a PR appear in both `processed` and `failed` simultaneously,
      // contradicting PollResult's contract that they're exclusive.
      const previousSha = state[String(pr.number)];
      state[String(pr.number)] = pr.headSha;
      try {
        await saveSeenState(options.statePath, state);
      } catch (saveError) {
        if (previousSha === undefined) delete state[String(pr.number)];
        else state[String(pr.number)] = previousSha;
        throw saveError;
      }

      processed.push({ pr, result });
    } catch (error) {
      failed.push({ pr, error });
    }
  }

  return { processed, skippedAlreadySeen, failed };
}
