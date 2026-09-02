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

test("createWebhookServer: unmatched repo -> 200 no-op, run() not called", async () => {
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
    assert.equal(status, 200);
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
