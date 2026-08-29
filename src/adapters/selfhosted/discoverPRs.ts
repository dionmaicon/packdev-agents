import type { getOctokit } from "@actions/github";

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
 * same reason as pipeline.ts's GitHubOps — so poll.ts's actual polling
 * logic (which PRs are new, which are already seen) is testable without
 * hitting the GitHub API.
 */
export interface PullRequestSource {
  listOpenBotPRs(): Promise<OpenBotPR[]>;
}

export interface OctokitPullRequestSourceConfig {
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
}

/** Real implementation. Deliberately thin — see octokitOps.ts for the same rationale. */
export function createOctokitPullRequestSource(
  config: OctokitPullRequestSourceConfig,
): PullRequestSource {
  return {
    async listOpenBotPRs(): Promise<OpenBotPR[]> {
      const prs = await config.octokit.paginate(config.octokit.rest.pulls.list, {
        owner: config.owner,
        repo: config.repo,
        state: "open",
      });

      return prs.map((pr) => ({
        number: pr.number,
        actor: pr.user?.login ?? "",
        baseBranch: pr.base.ref,
        baseSha: pr.base.sha,
        headBranch: pr.head.ref,
        headSha: pr.head.sha,
      }));
    },
  };
}
