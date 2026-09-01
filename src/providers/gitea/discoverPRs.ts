import type { PullRequestSource, OpenBotPR } from "../types.js";

export interface GiteaPullRequestSourceConfig {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
}

interface GiteaPullRequest {
  number: number;
  user: { login: string } | null;
  base: { ref: string; sha: string };
  head: { ref: string; sha: string };
}

/**
 * Real Gitea implementation of PullRequestSource — same interface
 * github/discoverPRs.ts's Octokit version implements, so poll.ts's polling
 * logic doesn't care which provider a PR came from. Gitea's PR list
 * response mirrors GitHub's shape closely enough (confirmed against a
 * live Gitea instance's swagger.v1.json: number/user.login/base/head all
 * present) that the field mapping below is a straight passthrough.
 */
export function createGiteaPullRequestSource(config: GiteaPullRequestSourceConfig): PullRequestSource {
  return {
    async listOpenBotPRs(): Promise<OpenBotPR[]> {
      const response = await fetch(
        `${config.baseUrl}/api/v1/repos/${config.owner}/${config.repo}/pulls?state=open`,
        { headers: { Authorization: `token ${config.token}` } },
      );
      if (!response.ok) {
        throw new Error(`Gitea API GET pulls -> ${response.status}: ${await response.text()}`);
      }
      const prs = (await response.json()) as GiteaPullRequest[];

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
