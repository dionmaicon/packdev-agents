import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { createWebhookServer, type WebhookServer } from "../../../src/adapters/webhook/server.ts";
import type { Provider } from "../../../src/providers/types.ts";

function fakeProvider(verify: (rawBody: Buffer, headers: NodeJS.Dict<string | string[]>) => boolean): Provider {
  return {
    createPullRequestSource: () => {
      throw new Error("not used in these tests");
    },
    createForgeOpsFor: () => {
      throw new Error("not used in these tests");
    },
    createGitRemote: () => {
      throw new Error("not used in these tests");
    },
    verifyWebhookSignature: verify,
  };
}

async function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", "content-length": payload.length, ...headers } },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

async function withServer(server: WebhookServer, fn: () => Promise<void>): Promise<void> {
  await server.start();
  try {
    await fn();
  } finally {
    await server.stop();
  }
}

test("createWebhookServer: valid signed request for a configured repo triggers run()", async () => {
  let ranCount = 0;
  const server = createWebhookServer({
    port: 18080,
    path: "/webhook",
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => true),
          run: async () => {
            ranCount++;
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    const status = await post(18080, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } }, { "x-signature": "whatever" });
    assert.equal(status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ranCount, 1);
  });
});

test("createWebhookServer: unmatched repo -> 401 (SAME as a bad signature, not 200) — no repo-enumeration oracle, run() not called", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18081,
    path: "/webhook",
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => true),
          run: async () => {
            ran = true;
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    const status = await post(18081, "/webhook", { action: "opened", repository: { full_name: "owner/other" } });
    assert.equal(status, 401);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: bad signature -> 401, run() not called", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18082,
    path: "/webhook",
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => false),
          run: async () => {
            ran = true;
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    const status = await post(18082, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } });
    assert.equal(status, 401);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: irrelevant action -> 200 no-op, run() not called", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18083,
    path: "/webhook",
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => true),
          run: async () => {
            ran = true;
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    const status = await post(18083, "/webhook", { action: "closed", repository: { full_name: "owner/repo" } });
    assert.equal(status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: wrong method/path -> 404", async () => {
  const server = createWebhookServer({ port: 18084, path: "/webhook", repos: new Map() });
  await withServer(server, async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: 18084, path: "/not-webhook", method: "POST" }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode!));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 404);
  });
});

test("createWebhookServer: coalescing — two triggers while a run is in flight produce exactly one additional run", async () => {
  let runCount = 0;
  let releaseFirstRun: (() => void) | undefined;
  let resolveFirstRunStarted: (() => void) | undefined;
  const firstRunStarted = new Promise<void>((resolve) => {
    resolveFirstRunStarted = resolve;
  });

  const server = createWebhookServer({
    port: 18085,
    path: "/webhook",
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => true),
          run: async () => {
            runCount++;
            if (runCount === 1) {
              resolveFirstRunStarted?.();
              await new Promise<void>((resolve) => {
                releaseFirstRun = resolve;
              });
            }
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    // First trigger starts a run that blocks until releaseFirstRun() is called.
    await post(18085, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } });
    await firstRunStarted;
    assert.equal(runCount, 1);

    // Two more triggers arrive while the first run is still in flight —
    // must coalesce into exactly one follow-up run, not two, not zero.
    await post(18085, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } });
    await post(18085, "/webhook", { action: "synchronize", repository: { full_name: "owner/repo" } });

    releaseFirstRun?.();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(runCount, 2);
  });
});

test("createWebhookServer: Gitea's 'synchronized' action spelling triggers run() too", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18086,
    path: "/webhook",
    repos: new Map([
      ["owner/repo", { provider: fakeProvider(() => true), run: async () => { ran = true; } }],
    ]),
  });

  await withServer(server, async () => {
    await post(18086, "/webhook", { action: "synchronized", repository: { full_name: "owner/repo" } });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, true);
  });
});

test("createWebhookServer: event-type header not pull_request (e.g. GitHub 'issues') -> 200 no-op, run() not called even though action/repository match", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18087,
    path: "/webhook",
    repos: new Map([
      ["owner/repo", { provider: fakeProvider(() => true), run: async () => { ran = true; } }],
    ]),
  });

  await withServer(server, async () => {
    const status = await post(
      18087,
      "/webhook",
      { action: "opened", repository: { full_name: "owner/repo" } },
      { "x-github-event": "issues" },
    );
    assert.equal(status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: event-type header IS pull_request -> triggers run() normally", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18088,
    path: "/webhook",
    repos: new Map([
      ["owner/repo", { provider: fakeProvider(() => true), run: async () => { ran = true; } }],
    ]),
  });

  await withServer(server, async () => {
    await post(
      18088,
      "/webhook",
      { action: "opened", repository: { full_name: "owner/repo" } },
      { "x-gitea-event": "pull_request" },
    );
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, true);
  });
});

test("createWebhookServer: oversized body -> 413, run() not called", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18089,
    path: "/webhook",
    repos: new Map([
      ["owner/repo", { provider: fakeProvider(() => true), run: async () => { ran = true; } }],
    ]),
  });

  await withServer(server, async () => {
    // Oversized via a declared Content-Length past the server's cap —
    // exercises the fast-reject path without actually sending 1MB+.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: 18089,
          path: "/webhook",
          method: "POST",
          headers: { "content-type": "application/json", "content-length": 2 * 1024 * 1024 },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end(Buffer.alloc(1024)); // body itself doesn't need to match content-length for this check
    });
    assert.equal(status, 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: oversized body via STREAMING (chunked, no Content-Length) -> a clean 413 response, not ECONNRESET", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18098,
    path: "/webhook",
    repos: new Map([
      ["owner/repo", { provider: fakeProvider(() => true), run: async () => { ran = true; } }],
    ]),
  });

  await withServer(server, async () => {
    // No content-length header -> Node sends this as a chunked-encoded
    // request, so the server only discovers the overflow while streaming
    // "data" events, not via the Content-Length fast path. Regression
    // check for readRawBody destroying the socket mid-response, which
    // used to surface as the client's request erroring with ECONNRESET
    // instead of receiving the intended 413.
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: 18098, path: "/webhook", method: "POST", headers: { "content-type": "application/json" } },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode!));
        },
      );
      req.on("error", reject);
      const chunk = Buffer.alloc(256 * 1024, "a"); // 256KB per write, 8 writes -> 2MB total, over the 1MB cap
      for (let i = 0; i < 8; i++) req.write(chunk);
      req.end();
    });
    assert.equal(status, 413);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: a verifyWebhookSignature that THROWS (contract violation) is treated as unverified, not an unhandled rejection", async () => {
  let ran = false;
  const server = createWebhookServer({
    port: 18090,
    path: "/webhook",
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => {
            throw new Error("buggy PACKDEV_PROVIDER_MODULE");
          }),
          run: async () => {
            ran = true;
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    const status = await post(18090, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } });
    assert.equal(status, 401);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(ran, false);
  });
});

test("createWebhookServer: a run() that fails is retried with the configured backoff, then succeeds", async () => {
  let attempts = 0;
  const server = createWebhookServer({
    port: 18091,
    path: "/webhook",
    retryDelaysMs: [10, 10],
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => true),
          run: async () => {
            attempts++;
            if (attempts < 3) throw new Error("transient forge failure");
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    await post(18091, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(attempts, 3);
  });
});

test("createWebhookServer: a run() that keeps failing gives up after the configured retries, doesn't retry forever", async () => {
  let attempts = 0;
  const server = createWebhookServer({
    port: 18092,
    path: "/webhook",
    retryDelaysMs: [10, 10],
    repos: new Map([
      [
        "owner/repo",
        {
          provider: fakeProvider(() => true),
          run: async () => {
            attempts++;
            throw new Error("permanent forge failure");
          },
        },
      ],
    ]),
  });

  await withServer(server, async () => {
    await post(18092, "/webhook", { action: "opened", repository: { full_name: "owner/repo" } });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(attempts, 3); // 1 initial + 2 retries (retryDelaysMs.length)
  });
});

test("createWebhookServer: start() rejects on a bind failure (e.g. EADDRINUSE) instead of throwing an uncaught error", async () => {
  const blocker = http.createServer();
  await new Promise<void>((resolve) => blocker.listen(18093, resolve));
  try {
    const server = createWebhookServer({ port: 18093, path: "/webhook", repos: new Map() });
    await assert.rejects(() => server.start());
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});
