import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import { createGithubProvider } from "../../../src/providers/github/index.ts";

function baseEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    REPO: "owner/repo",
    GITHUB_TOKEN: "t",
    ...overrides,
  };
}

function sign(secret: string, body: Buffer): string {
  return "sha256=" + crypto.createHmac("sha256", secret).update(body).digest("hex");
}

test("verifyWebhookSignature: valid signature -> true", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const headers = { "x-hub-signature-256": sign("s3cret", body) };
  assert.equal(provider.verifyWebhookSignature!(body, headers), true);
});

test("verifyWebhookSignature: tampered body -> false", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const headers = { "x-hub-signature-256": sign("s3cret", body) };
  const tampered = Buffer.from(JSON.stringify({ hello: "mallory" }));
  assert.equal(provider.verifyWebhookSignature!(tampered, headers), false);
});

test("verifyWebhookSignature: wrong secret -> false", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const headers = { "x-hub-signature-256": sign("wrong-secret", body) };
  assert.equal(provider.verifyWebhookSignature!(body, headers), false);
});

test("verifyWebhookSignature: missing header -> false, does not throw", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, {}), false);
});

test("verifyWebhookSignature: malformed header (no sha256= prefix) -> false", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, { "x-hub-signature-256": "deadbeef" }), false);
});

test("verifyWebhookSignature: missing GITHUB_WEBHOOK_SECRET -> false, does not throw", () => {
  const provider = createGithubProvider(baseEnv());
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const headers = { "x-hub-signature-256": sign("whatever", body) };
  assert.equal(provider.verifyWebhookSignature!(body, headers), false);
});

test("verifyWebhookSignature: a correct 64-char digest with trailing garbage -> false, not silently truncated and accepted", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  const validSig = sign("s3cret", body); // "sha256=<64 hex chars>"
  assert.equal(provider.verifyWebhookSignature!(body, { "x-hub-signature-256": validSig + "zz" }), false);
});

test("verifyWebhookSignature: a short (truncated) digest -> false", () => {
  const provider = createGithubProvider(baseEnv({ GITHUB_WEBHOOK_SECRET: "s3cret" }));
  const body = Buffer.from(JSON.stringify({ hello: "world" }));
  assert.equal(provider.verifyWebhookSignature!(body, { "x-hub-signature-256": "sha256=deadbeef" }), false);
});
