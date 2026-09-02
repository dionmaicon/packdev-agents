import type { Provider, ProviderFactory } from "../types.js";
import { createGiteaOps } from "./ops.js";
import { createGiteaPullRequestSource } from "./discoverPRs.js";

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseRepo(env: NodeJS.ProcessEnv): { owner: string; repo: string } {
  const value = requireEnv(env, "REPO");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`REPO must be "owner/repo", got "${value}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Built-in "gitea" provider — see registry.ts for how PROVIDER selects this. */
export const createGiteaProvider: ProviderFactory = (env): Provider => {
  const { owner, repo } = parseRepo(env);
  // A trailing slash (a common way to write a base URL, e.g.
  // "https://gitea.example.com/") would otherwise produce "//api/v1" and a
  // double-slash clone URL — some servers redirect that, and a redirect
  // silently downgrades a POST/PATCH to a GET, breaking comments/merges.
  const baseUrl = requireEnv(env, "GITEA_URL").replace(/\/+$/, "");
  const token = requireEnv(env, "GITEA_TOKEN");
  const username = requireEnv(env, "GITEA_USERNAME");

  return {
    createPullRequestSource: () => createGiteaPullRequestSource({ baseUrl, token, owner, repo }),
    createForgeOpsFor: (pr) => createGiteaOps({ baseUrl, token, owner, repo, prNumber: pr.number, headSha: pr.headSha }),
    createGitRemote: () => ({
      url: `${baseUrl}/${owner}/${repo}.git`,
      // Gitea's git-http-backend authenticates like standard HTTP Basic
      // auth: the token owner's real username plus the PAT as the
      // password — a bare token with an empty password is rejected for
      // private repos, so GITEA_USERNAME (the token owner) is required.
      // Applied per-request instead of persisted to disk — see GitRemote's
      // doc comment in providers/types.ts.
      authHeader: `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
    }),
  };
};
