import type { ForgeOps, CommentInput, CheckRunInput } from "../../core/pipeline.js";

export interface GiteaOpsConfig {
  baseUrl: string;
  token: string;
  owner: string;
  repo: string;
  prNumber: number;
}

interface GiteaComment {
  id: number;
  body: string;
}

/**
 * Minimal Gitea REST client shared between upsertComment/mergePullRequest —
 * Gitea has no equivalent to Octokit, so this is plain fetch against
 * /api/v1, same rationale as github/ops.ts (thin translation layer, no
 * decision logic).
 */
async function giteaFetch(
  config: Pick<GiteaOpsConfig, "baseUrl" | "token">,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(`${config.baseUrl}/api/v1${path}`, {
    ...init,
    headers: {
      Authorization: `token ${config.token}`,
      "Content-Type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gitea API ${init.method ?? "GET"} ${path} -> ${response.status}: ${body}`);
  }
  return response;
}

/**
 * Real Gitea implementation of ForgeOps, for PROVIDER=gitea. Gitea has
 * no Checks API (that's a GitHub App / GitHub Actions concept, not a Gitea
 * one) — createCheckRun is a deliberate no-op here, same "bonus signal, not
 * load-bearing" reasoning as github/ops.ts's best-effort createCheckRun,
 * just with nothing to even attempt. mergePullRequest posts Gitea's own
 * MergePullRequestOption shape ({"Do": "merge"}) — confirmed against a
 * live Gitea instance's swagger.v1.json; it is NOT the same body shape as
 * GitHub's pulls.merge, so this can't reuse github/ops.ts's call.
 */
export function createGiteaOps(config: GiteaOpsConfig): ForgeOps {
  const { owner, repo, prNumber } = config;

  return {
    async upsertComment(input: CommentInput): Promise<void> {
      const listResponse = await giteaFetch(config, `/repos/${owner}/${repo}/issues/${prNumber}/comments`);
      const comments = (await listResponse.json()) as GiteaComment[];
      const existing = comments.find((c) => c.body?.includes(input.marker));

      if (existing) {
        await giteaFetch(config, `/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
          method: "PATCH",
          body: JSON.stringify({ body: input.body }),
        });
      } else {
        await giteaFetch(config, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
          method: "POST",
          body: JSON.stringify({ body: input.body }),
        });
      }
    },

    async createCheckRun(_input: CheckRunInput): Promise<void> {
      // No-op: Gitea has no Checks API to call. See doc comment above.
    },

    async mergePullRequest(): Promise<void> {
      await giteaFetch(config, `/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
        method: "POST",
        body: JSON.stringify({ Do: "merge" }),
      });
    },
  };
}
