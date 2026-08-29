import { runGithubPipeline, DEFAULT_ALLOWED_ACTORS, type GitHubOps, type RunGithubPipelineResult } from "../../core/pipeline.js";
import type { Brain } from "../../core/brain.js";
import { ensureLocalClone, fetchBranch } from "./repoSync.js";
import { loadSeenState, saveSeenState } from "./state.js";
import type { OpenBotPR, PullRequestSource } from "./discoverPRs.js";

export interface PollOptions {
  /** Local working copy of the target repo. Cloned on first use, fetched to update on later polls. */
  cloneDir: string;
  remoteUrl: string;
  /** Where seen-PR state (see state.ts) is persisted between polls/restarts. */
  statePath: string;
  testCommand: string;
  prSource: PullRequestSource;
  /** Builds the GitHubOps sink for a specific PR — needs the PR number and head SHA to address comments/checks at. */
  githubOpsFor: (pr: OpenBotPR) => GitHubOps;
  /** See RunGithubPipelineOptions.packageJsonPath — for a monorepo target, e.g. "packages/api/package.json". */
  packageJsonPath?: string | undefined;
  allowedActors?: string[] | undefined;
  autoMerge?: boolean | undefined;
  brain?: Brain | undefined;
}

export interface ProcessedPR {
  pr: OpenBotPR;
  result: RunGithubPipelineResult;
}

export interface PollResult {
  processed: ProcessedPR[];
  skippedAlreadySeen: OpenBotPR[];
}

/**
 * One polling cycle: sync the local clone, list open bot PRs, and run the
 * shared core pipeline (see docs/architecture.md) against every PR that's
 * new or has moved to a new head SHA since it was last processed. State is
 * saved after EACH PR, not once at the end — a crash partway through a
 * batch must not lose progress already made or cause already-handled PRs
 * to be reprocessed and re-commented on restart.
 */
export async function pollOnce(options: PollOptions): Promise<PollResult> {
  await ensureLocalClone({ cloneDir: options.cloneDir, remoteUrl: options.remoteUrl });

  const state = await loadSeenState(options.statePath);
  const allPRs = await options.prSource.listOpenBotPRs();
  const allowedActors = options.allowedActors ?? DEFAULT_ALLOWED_ACTORS;

  const processed: ProcessedPR[] = [];
  const skippedAlreadySeen: OpenBotPR[] = [];

  for (const pr of allPRs) {
    if (!allowedActors.includes(pr.actor)) continue;

    if (state[String(pr.number)] === pr.headSha) {
      skippedAlreadySeen.push(pr);
      continue;
    }

    await fetchBranch(options.cloneDir, pr.baseBranch);
    await fetchBranch(options.cloneDir, pr.headBranch);

    const result = await runGithubPipeline({
      repoDir: options.cloneDir,
      // Exact SHAs from the PR API response, not the branch names just
      // fetched — a branch can move between the fetch above and
      // extractBump/prepareWorkspace reading it; the SHA can't.
      baseRef: pr.baseSha,
      headRef: pr.headSha,
      actor: pr.actor,
      testCommand: options.testCommand,
      github: options.githubOpsFor(pr),
      allowedActors: options.allowedActors,
      autoMerge: options.autoMerge,
      brain: options.brain,
      ...(options.packageJsonPath ? { packageJsonPath: options.packageJsonPath } : {}),
    });

    processed.push({ pr, result });

    state[String(pr.number)] = pr.headSha;
    await saveSeenState(options.statePath, state);
  }

  return { processed, skippedAlreadySeen };
}
