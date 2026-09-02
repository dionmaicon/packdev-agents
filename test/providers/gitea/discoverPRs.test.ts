import { test } from "node:test";
import assert from "node:assert/strict";

import { createGiteaPullRequestSource } from "../../../src/providers/gitea/discoverPRs.js";

test("listOpenBotPRs: maps a real Gitea PR list response shape onto OpenBotPR", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    assert.match(url, /\/repos\/o\/r\/pulls\?state=open&page=1&limit=50$/);
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

test("listOpenBotPRs: a full first page means there might be more — fetches page 2 too, stops on a short page", async () => {
  const originalFetch = globalThis.fetch;
  const requestedPages: number[] = [];
  const makePr = (n: number) => ({
    number: n,
    user: { login: "renovate" },
    base: { ref: "master", sha: `base${n}` },
    head: { ref: `bump-${n}`, sha: `head${n}` },
  });

  globalThis.fetch = (async (url: string) => {
    const page = Number(new URL(url).searchParams.get("page"));
    requestedPages.push(page);
    // Page 1 is a FULL page (exactly limit=50) — must not be treated as the last page.
    const prs = page === 1 ? Array.from({ length: 50 }, (_, i) => makePr(i + 1)) : [makePr(51)];
    return { ok: true, json: async () => prs, text: async () => "" } as Response;
  }) as typeof fetch;

  try {
    const source = createGiteaPullRequestSource({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r" });
    const prs = await source.listOpenBotPRs();
    assert.deepEqual(requestedPages, [1, 2]);
    assert.equal(prs.length, 51);
    assert.equal(prs[50]!.number, 51);
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
