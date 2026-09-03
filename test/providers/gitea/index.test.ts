import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createGiteaProvider } from "../../../src/providers/gitea/index.ts";

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    REPO: "owner/repo",
    GITEA_URL: "https://gitea.example.com",
    GITEA_TOKEN: "t",
    GITEA_USERNAME: "u",
    ...overrides,
  };
}

test("createGiteaProvider: GITEA_URL without a trailing slash -> clean clone URL", () => {
  const provider = createGiteaProvider(baseEnv());
  assert.equal(provider.createGitRemote().url, "https://gitea.example.com/owner/repo.git");
});

test("createGiteaProvider: GITEA_URL WITH a trailing slash -> normalized, no double slash", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_URL: "https://gitea.example.com/" }));
  assert.equal(provider.createGitRemote().url, "https://gitea.example.com/owner/repo.git");
});

test("createGiteaProvider: GITEA_URL with MULTIPLE trailing slashes -> normalized", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_URL: "https://gitea.example.com///" }));
  assert.equal(provider.createGitRemote().url, "https://gitea.example.com/owner/repo.git");
});

function sign(secret: string, body: Buffer): string {
  return crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("verifyWebhookSignature: valid signature -> true", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, { "x-gitea-signature": sign("s3cret", body) }), true);
});

test("verifyWebhookSignature: tampered body -> false", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const tampered = Buffer.from(JSON.stringify({ hello: "mallory" }));
  assert.equal(provider.verifyWebhookSignature!(tampered, { "x-gitea-signature": sign("s3cret", body) }), false);
});

test("verifyWebhookSignature: wrong secret -> false", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, { "x-gitea-signature": sign("wrong-secret", body) }), false);
});

test("verifyWebhookSignature: missing header -> false, does not throw", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, {}), false);
});

test("verifyWebhookSignature: missing GITEA_WEBHOOK_SECRET -> false, does not throw", () => {
  const provider = createGiteaProvider(baseEnv());
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, { "x-gitea-signature": sign("whatever", body) }), false);
});

test("verifyWebhookSignature: a correct 64-char digest with trailing garbage -> false, not silently truncated and accepted", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const validSig = sign("s3cret", body); // 64 hex chars
  assert.equal(provider.verifyWebhookSignature!(body, { "x-gitea-signature": validSig + "zz" }), false);
});

test("verifyWebhookSignature: a short (truncated) digest -> false", () => {
  const provider = createGiteaProvider(baseEnv({ GITEA_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, { "x-gitea-signature": "deadbeef" }), false);
});
