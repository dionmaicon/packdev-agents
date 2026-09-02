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
const PAGE_SIZE = 50;

export function createGiteaPullRequestSource(config: GiteaPullRequestSourceConfig): PullRequestSource {
  return {
    async listOpenBotPRs(): Promise<OpenBotPR[]> {
      // Gitea's pull-list endpoint is paginated (like GitHub's) — reading
      // only page 1 silently drops bot PRs beyond the server's default page
      // size on a repo with enough open PRs. Loop until a short page (or an
      // empty one) signals the last page, same stopping condition
      // Octokit's own .paginate uses internally for the github provider.
      const allPrs: GiteaPullRequest[] = [];
      for (let page = 1; ; page++) {
        const response = await fetch(
          `${config.baseUrl}/api/v1/repos/${config.owner}/${config.repo}/pulls?state=open&page=${page}&limit=${PAGE_SIZE}`,
          { headers: { Authorization: `token ${config.token}` } },
        );
        if (!response.ok) {
          throw new Error(`Gitea API GET pulls -> ${response.status}: ${await response.text()}`);
        }
        const pagePrs = (await response.json()) as GiteaPullRequest[];
        allPrs.push(...pagePrs);
        if (pagePrs.length < PAGE_SIZE) break;
      }

      return allPrs.map((pr) => ({
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
