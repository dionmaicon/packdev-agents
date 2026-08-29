import type { getOctokit } from "@actions/github";
import type { GitHubOps, CommentInput, CheckRunInput } from "./pipeline.js";

export interface OctokitOpsConfig {
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * The real GitHub API wiring behind GitHubOps. Deliberately thin — all the
 * actual decision logic lives in pipeline.ts and is tested there without
 * needing GitHub API access. This file just translates GitHubOps calls into
 * Octokit calls; if something here is wrong it will show up as a broken PR
 * comment/check in practice, not as a subtle logic bug.
 */
export function createOctokitOps(config: OctokitOpsConfig): GitHubOps {
  const { octokit, owner, repo, prNumber, headSha } = config;

  return {
    async upsertComment(input: CommentInput): Promise<void> {
      const comments = await octokit.paginate(octokit.rest.issues.listComments, {
        owner,
        repo,
        issue_number: prNumber,
      });
      const existing = comments.find((c) => c.body?.includes(input.marker));

      if (existing) {
        await octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existing.id,
          body: input.body,
        });
      } else {
        await octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: input.body,
        });
      }
    },

    async createCheckRun(input: CheckRunInput): Promise<void> {
      await octokit.rest.checks.create({
        owner,
        repo,
        name: input.name,
        head_sha: headSha,
        status: "completed",
        conclusion: input.conclusion,
        output: {
          title: input.title,
          summary: input.summary,
        },
      });
    },

    async mergePullRequest(): Promise<void> {
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
      });
    },
  };
}
