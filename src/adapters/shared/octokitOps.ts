import type { getOctokit } from "@actions/github";
import type { GitHubOps, CommentInput, CheckRunInput } from "../../core/pipeline.js";

export interface OctokitOpsConfig {
  octokit: ReturnType<typeof getOctokit>;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * The real GitHub API wiring behind GitHubOps. Deliberately thin — all the
 * actual decision logic lives in the pipelines that consume GitHubOps and
 * is tested there without needing GitHub API access. This file just
 * translates GitHubOps calls into Octokit calls; if something here is
 * wrong it will show up as a broken PR comment/check in practice, not as
 * a subtle logic bug. Lives under adapters/shared/, not any one specific
 * adapter's directory, because every adapter that talks to GitHub
 * (github-action, selfhosted, agentic-triage) needs the exact same
 * translation — adapters don't import each other, only core and shared.
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
      // Best-effort, not fatal: the Checks API requires the token to
      // belong to a GitHub App installation — a plain PAT (what a
      // self-hosted operator's GITHUB_TOKEN most likely is) can never
      // create a check run, full stop, no permission grant fixes it.
      // upsertComment above is the primary output and needs no special
      // token type; letting a checks.create failure take the whole PR
      // result down with it (caught live: an unhandled HttpError aborted
      // the PR before the comment ever posted) would make check runs a
      // hard GitHub-App requirement by accident. They're a bonus signal,
      // not a load-bearing one.
      try {
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
      } catch (error) {
        console.error(
          `createCheckRun failed (continuing without it — check runs require a GitHub App token): ${String(error)}`,
        );
      }
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
