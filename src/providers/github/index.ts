import { Octokit } from "@octokit/rest";

import type { Provider, ProviderFactory } from "../types.js";
import { createOctokitOps } from "./ops.js";
import { createOctokitPullRequestSource } from "./discoverPRs.js";

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseRepo(env: NodeJS.ProcessEnv): { owner: string; repo: string } {
  const [owner, repo] = requireEnv(env, "REPO").split("/");
  if (!owner || !repo) {
    throw new Error(`REPO must be "owner/repo", got "${env["REPO"]}"`);
  }
  return { owner, repo };
}

/** Built-in "github" provider — see registry.ts for how PROVIDER selects this. */
export const createGithubProvider: ProviderFactory = (env): Provider => {
  const { owner, repo } = parseRepo(env);
  const token = requireEnv(env, "GITHUB_TOKEN");
  const octokit = new Octokit({ auth: token });

  return {
    createPullRequestSource: () => createOctokitPullRequestSource({ octokit, owner, repo }),
    createForgeOpsFor: (pr) =>
      createOctokitOps({ octokit, owner, repo, prNumber: pr.number, headSha: pr.headSha }),
    createGitRemote: () => ({
      url: `https://github.com/${owner}/${repo}.git`,
      // Same Basic-auth shape git itself generates for a `https://TOKEN@host/...`
      // URL — just applied per-request instead of persisted to disk. See
      // GitRemote's doc comment in providers/types.ts.
      authHeader: `Authorization: Basic ${Buffer.from(`${token}:`).toString("base64")}`,
    }),
  };
};
