import { runAgenticTriagePipeline, type RunAgenticTriagePipelineResult } from "./pipeline.js";
import type { AgentLoop } from "./agentLoop.js";
import { ensureLocalClone, fetchBranch } from "../selfhosted/repoSync.js";
import { loadSeenState, saveSeenState } from "../selfhosted/state.js";
import type { OpenBotPR, PullRequestSource } from "../../providers/types.js";
import { DEFAULT_ALLOWED_ACTORS, type ForgeOps } from "../../core/pipeline.js";

export interface TriagePollOptions {
  cloneDir: string;
  remoteUrl: string;
  /** Separate state file from the compat pipeline's — a PR can be at the same head SHA for both, but each pipeline tracks its own "have I posted my comment for this head yet" independently. */
  statePath: string;
  prSource: PullRequestSource;
  forgeOpsFor: (pr: OpenBotPR) => ForgeOps;
  agentLoop: AgentLoop;
  maxTurns?: number | undefined;
  packageJsonPath?: string | undefined;
  allowedActors?: string[] | undefined;
}

export interface ProcessedTriagePR {
  pr: OpenBotPR;
  result: RunAgenticTriagePipelineResult;
}

export interface FailedTriagePR {
  pr: OpenBotPR;
  error: unknown;
}

export interface TriagePollResult {
  processed: ProcessedTriagePR[];
  skippedAlreadySeen: OpenBotPR[];
  failed: FailedTriagePR[];
}

/**
 * The agentic-triage equivalent of selfhosted/poll.ts's pollOnce — same
 * discover-all-open-bot-PRs, skip-already-seen-heads, isolate-per-PR-
 * failures shape, generalized from the single-PR_NUMBER script this used
 * to be (mainGitea.ts) so `triage` has real parity with `compat`: it now
 * discovers every open bot PR itself instead of requiring the caller to
 * already know a PR number.
 */
export async function pollTriageOnce(options: TriagePollOptions): Promise<TriagePollResult> {
  await ensureLocalClone({ cloneDir: options.cloneDir, remoteUrl: options.remoteUrl });

  const state = await loadSeenState(options.statePath);
  const allPRs = await options.prSource.listOpenBotPRs();
  const allowedActors = options.allowedActors ?? DEFAULT_ALLOWED_ACTORS;

  const processed: ProcessedTriagePR[] = [];
  const skippedAlreadySeen: OpenBotPR[] = [];
  const failed: FailedTriagePR[] = [];

  for (const pr of allPRs) {
    if (!allowedActors.includes(pr.actor)) continue;

    if (state[String(pr.number)] === pr.headSha) {
      skippedAlreadySeen.push(pr);
      continue;
    }

    try {
      await fetchBranch(options.cloneDir, pr.baseBranch);
      await fetchBranch(options.cloneDir, pr.headBranch);

      const result = await runAgenticTriagePipeline({
        repoDir: options.cloneDir,
        baseRef: pr.baseSha,
        headRef: pr.headSha,
        actor: pr.actor,
        forge: options.forgeOpsFor(pr),
        agentLoop: options.agentLoop,
        allowedActors: options.allowedActors,
        ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
        ...(options.packageJsonPath ? { packageJsonPath: options.packageJsonPath } : {}),
      });

      // Same save-before-push ordering as selfhosted/poll.ts, and for the
      // same reason — see that file's doc comment for the real bug this
      // ordering fixed.
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
