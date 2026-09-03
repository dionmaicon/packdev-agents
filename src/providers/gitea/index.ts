import crypto from "node:crypto";

import type { Provider, ProviderFactory } from "../types.js";
import { createGiteaOps } from "./ops.js";
import { createGiteaPullRequestSource } from "./discoverPRs.js";

function verifyGiteaWebhookSignature(
  env: NodeJS.ProcessEnv,
  rawBody: Buffer,
  headers: NodeJS.Dict<string | string[]>,
): boolean {
  const secret = env["PACKDEV_PROVIDER_WEBHOOK_SECRET"];
  if (!secret) return false;
  const header = headers["x-gitea-signature"];
  const signatureHeader = Array.isArray(header) ? header[0] : header;
  if (!signatureHeader) return false;
  // Buffer.from(..., "hex") silently truncates at the first non-hex
  // character instead of rejecting the input — a header with the correct
  // 64-char digest followed by garbage would otherwise still decode (to
  // the correct 32 bytes) and pass. Require exactly a 64-char hex string
  // (SHA-256 digest length) before ever decoding it.
  if (!/^[0-9a-fA-F]{64}$/.test(signatureHeader)) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(signatureHeader, "hex");
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseRepo(env: NodeJS.ProcessEnv): { owner: string; repo: string } {
  const value = requireEnv(env, "PACKDEV_REPO");
  const parts = value.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`PACKDEV_REPO must be "owner/repo", got "${value}"`);
  }
  return { owner: parts[0], repo: parts[1] };
}

/** Built-in "gitea" provider — see registry.ts for how PACKDEV_PROVIDER selects this. */
export const createGiteaProvider: ProviderFactory = (env): Provider => {
  const { owner, repo } = parseRepo(env);
  // A trailing slash (a common way to write a base URL, e.g.
  // "https://gitea.example.com/") would otherwise produce "//api/v1" and a
  // double-slash clone URL — some servers redirect that, and a redirect
  // silently downgrades a POST/PATCH to a GET, breaking comments/merges.
  const baseUrl = requireEnv(env, "PACKDEV_PROVIDER_URL").replace(/\/+$/, "");
  const token = requireEnv(env, "PACKDEV_PROVIDER_TOKEN");
  const username = requireEnv(env, "PACKDEV_PROVIDER_USERNAME");

  return {
    createPullRequestSource: () => createGiteaPullRequestSource({ baseUrl, token, owner, repo }),
    createForgeOpsFor: (pr) => createGiteaOps({ baseUrl, token, owner, repo, prNumber: pr.number, headSha: pr.headSha }),
    createGitRemote: () => ({
      url: `${baseUrl}/${owner}/${repo}.git`,
      // Gitea's git-http-backend authenticates like standard HTTP Basic
      // auth: the token owner's real username plus the PAT as the
      // password — a bare token with an empty password is rejected for
      // private repos, so PACKDEV_PROVIDER_USERNAME (the token owner) is required.
      // Applied per-request instead of persisted to disk — see GitRemote's
      // doc comment in providers/types.ts.
      authHeader: `Authorization: Basic ${Buffer.from(`${username}:${token}`).toString("base64")}`,
    }),
    verifyWebhookSignature: (rawBody, headers) => verifyGiteaWebhookSignature(env, rawBody, headers),
  };
};
