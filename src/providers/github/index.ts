import crypto from "node:crypto";

import { Octokit } from "@octokit/rest";

import type { Provider, ProviderFactory } from "../types.js";
import { createOctokitOps } from "./ops.js";
import { createOctokitPullRequestSource } from "./discoverPRs.js";

function verifyGithubWebhookSignature(
  env: NodeJS.ProcessEnv,
  rawBody: Buffer,
  headers: NodeJS.Dict<string | string[]>,
): boolean {
  const secret = env["GITHUB_WEBHOOK_SECRET"];
  if (!secret) return false;
  const header = headers["x-hub-signature-256"];
  const signatureHeader = Array.isArray(header) ? header[0] : header;
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

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
      // GitHub's HTTPS git auth expects the token in the *password* slot;
      // `x-access-token` is GitHub's documented fixed username for this
      // (same shape GitHub Actions itself uses for `https://x-access-token:TOKEN@host/...`).
      // Applied per-request instead of persisted to disk — see GitRemote's
      // doc comment in providers/types.ts.
      authHeader: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
    }),
    verifyWebhookSignature: (rawBody, headers) => verifyGithubWebhookSignature(env, rawBody, headers),
  };
};
