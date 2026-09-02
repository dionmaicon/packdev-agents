import { test } from "node:test";
import assert from "node:assert/strict";

import { createGiteaOps } from "../../../src/providers/gitea/ops.js";

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function fakeFetch(calls: Call[], respond: (url: string, method: string) => { status: number; body: unknown }) {
  return async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    const { status, body } = respond(url, method);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  };
}

test("upsertComment: no existing comment with the marker -> POSTs a new comment", async () => {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(calls, (url, method) => {
    if (method === "GET") return { status: 200, body: [] };
    return { status: 201, body: {} };
  }) as typeof fetch;

  try {
    const ops = createGiteaOps({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r", prNumber: 5, headSha: "abc123" });
    await ops.upsertComment({ marker: "<!-- packdev-agents -->", body: "<!-- packdev-agents -->\nverdict" });

    const post = calls.find((c) => c.method === "POST");
    assert.ok(post);
    assert.match(post!.url, /\/repos\/o\/r\/issues\/5\/comments$/);
    assert.equal((post!.body as { body: string }).body, "<!-- packdev-agents -->\nverdict");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upsertComment: an existing comment with the marker -> PATCHes it instead of creating a new one", async () => {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(calls, (url, method) => {
    if (method === "GET") return { status: 200, body: [{ id: 42, body: "<!-- packdev-agents -->\nold" }] };
    return { status: 200, body: {} };
  }) as typeof fetch;

  try {
    const ops = createGiteaOps({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r", prNumber: 5, headSha: "abc123" });
    await ops.upsertComment({ marker: "<!-- packdev-agents -->", body: "<!-- packdev-agents -->\nnew" });

    const patch = calls.find((c) => c.method === "PATCH");
    const post = calls.find((c) => c.method === "POST");
    assert.ok(patch);
    assert.equal(post, undefined);
    assert.match(patch!.url, /\/repos\/o\/r\/issues\/comments\/42$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("upsertComment: the marker comment sitting on page 2 is found and PATCHed, not duplicated", async () => {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body ? JSON.parse(init.body as string) : undefined });
    if (method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      // Page 1 is a full page (50 comments, none of them the marker) —
      // must not be treated as the last page.
      const body =
        page === 1
          ? Array.from({ length: 50 }, (_, i) => ({ id: i + 1, body: `comment ${i + 1}` }))
          : [{ id: 999, body: "<!-- packdev-agents -->\nold" }];
      return { ok: true, status: 200, json: async () => body, text: async () => "" } as Response;
    }
    return { ok: true, status: 200, json: async () => ({}), text: async () => "" } as Response;
  }) as typeof fetch;

  try {
    const ops = createGiteaOps({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r", prNumber: 5, headSha: "abc123" });
    await ops.upsertComment({ marker: "<!-- packdev-agents -->", body: "<!-- packdev-agents -->\nnew" });

    const getPages = calls.filter((c) => c.method === "GET").map((c) => new URL(c.url).searchParams.get("page"));
    assert.deepEqual(getPages, ["1", "2"]);
    const patch = calls.find((c) => c.method === "PATCH");
    const post = calls.find((c) => c.method === "POST");
    assert.ok(patch, "expected the page-2 marker comment to be PATCHed");
    assert.equal(post, undefined, "must not POST a duplicate when the marker was found on a later page");
    assert.match(patch!.url, /\/repos\/o\/r\/issues\/comments\/999$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createCheckRun: no-op, Gitea has no Checks API to call", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("fetch should never be called by createCheckRun");
  }) as typeof fetch;

  try {
    const ops = createGiteaOps({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r", prNumber: 5, headSha: "abc123" });
    await assert.doesNotReject(ops.createCheckRun({ name: "packdev-agents", conclusion: "success", title: "t", summary: "s" }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("mergePullRequest: posts Gitea's own {Do: 'merge', head_commit_id} body shape, not GitHub's merge params", async () => {
  const calls: Call[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fakeFetch(calls, () => ({ status: 200, body: {} })) as typeof fetch;

  try {
    const ops = createGiteaOps({
      baseUrl: "https://gitea.example.com",
      token: "t",
      owner: "o",
      repo: "r",
      prNumber: 5,
      headSha: "abc123",
    });
    await ops.mergePullRequest();

    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/repos\/o\/r\/pulls\/5\/merge$/);
    // head_commit_id pins the merge to the exact head compat/triage tested
    // — Gitea rejects the merge if the PR's head has moved past this
    // commit since, instead of silently merging a newer, untested head.
    assert.deepEqual(calls[0]!.body, { Do: "merge", head_commit_id: "abc123" });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a non-ok response throws with the status and body in the message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: false,
      status: 403,
      json: async () => ({}),
      text: async () => "token does not have at least one of required scope(s)",
    }) as Response) as typeof fetch;

  try {
    const ops = createGiteaOps({ baseUrl: "https://gitea.example.com", token: "t", owner: "o", repo: "r", prNumber: 5, headSha: "abc123" });
    await assert.rejects(ops.mergePullRequest(), /403.*scope/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
