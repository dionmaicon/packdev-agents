import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSandboxEnv } from "../../src/core/childEnv.ts";

test("buildSandboxEnv: always sets npm_config_ignore_scripts=true", () => {
  const env = buildSandboxEnv({});
  assert.equal(env["npm_config_ignore_scripts"], "true");
});

test("buildSandboxEnv: strips secret-shaped keys (GITHUB_TOKEN, *_API_KEY, INPUT_*)", () => {
  const env = buildSandboxEnv({
    GITHUB_TOKEN: "ghp_secret",
    ANTHROPIC_API_KEY: "sk-secret",
    "INPUT_OPENAI-COMPATIBLE-API-KEY": "sk-secret-2",
    ZAI_API_KEY: "zai-secret",
    SOME_SECRET_THING: "hidden",
    DB_PASSWORD: "hunter2",
  });
  assert.equal(env["GITHUB_TOKEN"], undefined);
  assert.equal(env["ANTHROPIC_API_KEY"], undefined);
  assert.equal(env["INPUT_OPENAI-COMPATIBLE-API-KEY"], undefined);
  assert.equal(env["ZAI_API_KEY"], undefined);
  assert.equal(env["SOME_SECRET_THING"], undefined);
  assert.equal(env["DB_PASSWORD"], undefined);
});

test("buildSandboxEnv: keeps registry auth tokens installs may legitimately need", () => {
  const env = buildSandboxEnv({ NPM_TOKEN: "npm-token", NODE_AUTH_TOKEN: "node-token" });
  assert.equal(env["NPM_TOKEN"], "npm-token");
  assert.equal(env["NODE_AUTH_TOKEN"], "node-token");
});

test("buildSandboxEnv: keeps ordinary non-secret-shaped vars untouched", () => {
  const env = buildSandboxEnv({ PATH: "/usr/bin", NODE_ENV: "test", HOME: "/home/x" });
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["NODE_ENV"], "test");
  assert.equal(env["HOME"], "/home/x");
});
