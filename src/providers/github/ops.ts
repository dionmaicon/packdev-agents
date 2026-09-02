import type { Octokit } from "@octokit/rest";
import type { ForgeOps, CommentInput, CheckRunInput } from "../../core/pipeline.js";

export interface OctokitOpsConfig {
  octokit: Octokit;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
}

/**
 * The real GitHub API wiring behind ForgeOps. Deliberately thin — all the
 * actual decision logic lives in the pipelines that consume ForgeOps and
 * is tested there without needing GitHub API access. This file just
 * translates ForgeOps calls into Octokit calls; if something here is
 * wrong it will show up as a broken PR comment/check in practice, not as
 * a subtle logic bug. Uses plain @octokit/rest, not @actions/github — this
 * is the self-hosted/library-embeddable path, so it must not depend on
 * GitHub-Actions-only tooling (that's adapters/github-action/main.ts's job).
 */
export function createOctokitOps(config: OctokitOpsConfig): ForgeOps {
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
          `createCheckRun failed (continuing without it): ${String(error)}`,
        );
      }
    },

    async mergePullRequest(): Promise<void> {
      // `sha` pins the merge to the exact head commit compat/triage
      // actually tested — without it, GitHub merges whatever the CURRENT
      // head is, so a push landing on the PR between the test run and
      // this call would merge untested code. GitHub rejects the request
      // if head has moved past this sha instead of merging silently.
      await octokit.rest.pulls.merge({
        owner,
        repo,
        pull_number: prNumber,
        sha: headSha,
      });
    },
  };
}
