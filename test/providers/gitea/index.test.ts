import { test } from "node:test";
import assert from "node:assert/strict";

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
