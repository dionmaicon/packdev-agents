import type { ForgeOps } from "../core/pipeline.js";

export interface OpenBotPR {
  number: number;
  actor: string;
  baseBranch: string;
  baseSha: string;
  headBranch: string;
  headSha: string;
}

/**
 * Where the list of open PRs comes from, kept behind an interface for the
 * same reason as core/pipeline.ts's ForgeOps — so poll.ts's actual polling
 * logic (which PRs are new, which are already seen) is testable without
 * hitting any forge's API.
 */
export interface PullRequestSource {
  listOpenBotPRs(): Promise<OpenBotPR[]>;
}

/**
 * One forge, fully wired: how to discover open bot PRs, and how to talk
 * back to a specific PR (comment/check-run/merge). `registry.ts` resolves
 * one of these from the environment — either a built-in (github, gitea) or
 * a third party's own module via PROVIDER_MODULE, so adding a new forge
 * never requires a PR to this repo.
 */
export interface Provider {
  createPullRequestSource(): PullRequestSource;
  createForgeOpsFor(pr: OpenBotPR): ForgeOps;
}

/**
 * What a PROVIDER_MODULE must default-export. Receives process.env so it
 * can read its own provider-specific variables (e.g. GITEA_URL) the same
 * way the built-in providers do — see registry.ts.
 */
export type ProviderFactory = (env: NodeJS.ProcessEnv) => Provider;
