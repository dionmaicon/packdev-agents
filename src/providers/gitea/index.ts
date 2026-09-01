import type { Provider, ProviderFactory } from "../types.js";
import { createGiteaOps } from "./ops.js";
import { createGiteaPullRequestSource } from "./discoverPRs.js";

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

/** Built-in "gitea" provider — see registry.ts for how PROVIDER selects this. */
export const createGiteaProvider: ProviderFactory = (env): Provider => {
  const { owner, repo } = parseRepo(env);
  const baseUrl = requireEnv(env, "GITEA_URL");
  const token = requireEnv(env, "GITEA_TOKEN");

  return {
    createPullRequestSource: () => createGiteaPullRequestSource({ baseUrl, token, owner, repo }),
    createForgeOpsFor: (pr) => createGiteaOps({ baseUrl, token, owner, repo, prNumber: pr.number }),
  };
};
