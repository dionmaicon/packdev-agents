import { test } from "node:test";
import assert from "node:assert/strict";

import { createGiteaPullRequestSource } from "../../../src/providers/gitea/discoverPRs.js";

test("listOpenBotPRs: maps a real Gitea PR list response shape onto OpenBotPR", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.match(url, /\/repos\/o\/r\/pulls\?state=open$/);
    return {
      ok: true,
      json: async () => [
        {
          number: 7,
          user: { login: "renovate" },
          base: { ref: "master", sha: "aaa" },
          head: { ref: "renovate/foo-1.x", sha: "bbb" },
        },
      ],
      text: async () => "",
    } as Response;
  }) as typeof fetch;

  try {
    const source = createGiteaPullRequestSource({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r" });
    const prs = await source.listOpenBotPRs();
    assert.deepEqual(prs, [
      { number: 7, actor: "renovate", baseBranch: "master", baseSha: "aaa", headBranch: "renovate/foo-1.x", headSha: "bbb" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listOpenBotPRs: a PR with no user (deleted account) -> actor is empty string, not a crash", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: true,
      json: async () => [{ number: 1, user: null, base: { ref: "master", sha: "a" }, head: { ref: "x", sha: "b" } }],
      text: async () => "",
    }) as Response) as typeof fetch;

  try {
    const source = createGiteaPullRequestSource({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r" });
    const prs = await source.listOpenBotPRs();
    assert.equal(prs[0]!.actor, "");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listOpenBotPRs: a non-ok response throws with status and body", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({ ok: false, status: 401, json: async () => ({}), text: async () => "token is required" }) as Response) as typeof fetch;

  try {
    const source = createGiteaPullRequestSource({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r" });
    await assert.rejects(source.listOpenBotPRs(), /401.*token is required/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
