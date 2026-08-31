import { test } from "node:test";
import assert from "node:assert/strict";

import { buildSandboxEnv } from "../../src/core/childEnv.ts";

test("buildSandboxEnv: does NOT set npm_config_ignore_scripts by default", () => {
  // Regression guard for a real silent false PASSED (dionmaicon/packdev#6):
  // as a blanket default this also suppressed the APP's own pretest/prebuild
  // hooks during the test phase, so a NestJS app's tests never got compiled,
  // `node --test` found zero files, npm exited 0, and a genuinely broken
  // bump was reported as a clean pass. It must be a deliberate per-call-site
  // choice, never inherited silently.
  const env = buildSandboxEnv({});
  assert.equal(env["npm_config_ignore_scripts"], undefined);
});

test("buildSandboxEnv: sets npm_config_ignore_scripts=true when explicitly opted in", () => {
  const env = buildSandboxEnv({}, { ignoreScripts: true });
  assert.equal(env["npm_config_ignore_scripts"], "true");
});

test("buildSandboxEnv: secret scrubbing is unconditional, independent of the ignoreScripts choice", () => {
  for (const options of [{}, { ignoreScripts: true }, { ignoreScripts: false }]) {
    const env = buildSandboxEnv({ GITHUB_TOKEN: "ghp_secret", PATH: "/usr/bin" }, options);
    assert.equal(env["GITHUB_TOKEN"], undefined);
    assert.equal(env["PATH"], "/usr/bin");
  }
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

test("buildSandboxEnv: an INHERITED npm_config_ignore_scripts never leaks through when not opted in", () => {
  // `ignore-scripts=true` in a repo/user/CI .npmrc is standard supply-chain
  // hardening, and npm materializes its whole config as npm_config_* env
  // vars for any script it runs — so this arrives here set. Copied through,
  // it would suppress the app's own pretest hooks at exactly the call sites
  // that opted OUT, silently restoring the false-PASSED bug on such a host.
  const env = buildSandboxEnv({ npm_config_ignore_scripts: "true", PATH: "/usr/bin" });
  assert.equal(env["npm_config_ignore_scripts"], undefined);
  assert.equal(env["PATH"], "/usr/bin");
});

test("buildSandboxEnv: inherited ignore-scripts is dropped regardless of case or separator spelling", () => {
  const env = buildSandboxEnv({
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    "npm_config_ignore-scripts": "true",
  });
  assert.equal(env["NPM_CONFIG_IGNORE_SCRIPTS"], undefined);
  assert.equal(env["npm_config_ignore-scripts"], undefined);
});

test("buildSandboxEnv: opting in wins over an inherited FALSE value, and sets the canonical key only", () => {
  const env = buildSandboxEnv({ npm_config_ignore_scripts: "false" }, { ignoreScripts: true });
  assert.equal(env["npm_config_ignore_scripts"], "true");
});

test("buildSandboxEnv: strips NODE_TEST_CONTEXT so a nested test runner keeps its normal reporter", () => {
  // Real bug this guards: inherited by the sandboxed app's own `node
  // --test`, this switches that run from TAP to the v8-serialized
  // reporter, so packdev can't scrape the test counts and the
  // PASS_WITH_NO_TESTS caveat silently never fires — a zero-test run got
  // reported as a clean auto-mergeable PASSED, but only when the parent
  // happened to be running under node:test.
  const env = buildSandboxEnv({ NODE_TEST_CONTEXT: "child-v8", NODE_ENV: "test" });
  assert.equal(env["NODE_TEST_CONTEXT"], undefined);
  assert.equal(env["NODE_ENV"], "test");
});

test("buildSandboxEnv: keeps ordinary non-secret-shaped vars untouched", () => {
  const env = buildSandboxEnv({ PATH: "/usr/bin", NODE_ENV: "test", HOME: "/home/x" });
  assert.equal(env["PATH"], "/usr/bin");
  assert.equal(env["NODE_ENV"], "test");
  assert.equal(env["HOME"], "/home/x");
});
