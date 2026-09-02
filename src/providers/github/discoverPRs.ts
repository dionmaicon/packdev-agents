import type { Octokit } from "@octokit/rest";
import type { PullRequestSource, OpenBotPR } from "../types.js";

export interface OctokitPullRequestSourceConfig {
  octokit: Octokit;
  owner: string;
  repo: string;
}

/** Real implementation. Deliberately thin — see ops.ts for the same rationale. */
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
