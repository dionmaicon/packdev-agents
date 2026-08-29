import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import {
  renderWithBrain,
  createAnthropicBrain,
  createOpenAiCompatibleBrain,
  type Brain,
  type SummarizeFailureInput,
} from "../../src/core/brain.ts";
import { render } from "../../src/core/report.ts";
import { interpret } from "../../src/core/interpret.ts";
import type {
  CompatReport,
  CompatVersionResult,
} from "../../src/core/packdevTypes.ts";
import { PACKDEV_EXIT_CODE } from "../../src/core/packdevTypes.ts";

function version(
  overrides: Partial<CompatVersionResult> & { version: string },
): CompatVersionResult {
  return {
    status: "PASSED",
    exitCode: 0,
    durationMs: 1000,
    lockfileHash: null,
    lockfileSnapshotPath: null,
    ...overrides,
  };
}

function report(overrides: Partial<CompatReport> = {}): CompatReport {
  const control = version({ version: "1.0.0" });
  const candidate = version({ version: "1.1.0" });
  return {
    package: "some-pkg",
    minimumCompatibleVersion: null,
    recommendedVersion: null,
    nonMonotonic: false,
    versions: [control, candidate],
    snapshotDir: "/tmp/snapshots",
    concurrency: 1,
    testCommandCaveat: null,
    testCommandCaveats: [],
    control,
    controlFailed: false,
    sandboxMode: "hermetic",
    packageManager: "npm",
    seededLockfile: false,
    lockfileSeedNote: null,
    fanOutConsumers: [],
    ...overrides,
  };
}

function countingBrain(summary: string): { brain: Brain; calls: SummarizeFailureInput[] } {
  const calls: SummarizeFailureInput[] = [];
  return {
    calls,
    brain: {
      async summarizeFailure(input) {
        calls.push(input);
        return summary;
      },
    },
  };
}

test("renderWithBrain: no brain configured -> identical to render()", async () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "FAILED", output: "boom" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);

  const withoutBrain = await renderWithBrain(verdict);
  assert.equal(withoutBrain, render(verdict));
});

test("renderWithBrain: PASSED verdict never invokes the brain (nothing to summarize)", async () => {
  const r = report();
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  const { brain, calls } = countingBrain("should never appear");

  const result = await renderWithBrain(verdict, brain);
  assert.equal(calls.length, 0);
  assert.equal(result, render(verdict));
});

test("renderWithBrain: INCOMPATIBLE with output -> summary appended, raw output block preserved", async () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({
    version: "1.1.0",
    status: "FAILED",
    output: "TypeError: foo is not a function",
  });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);
  const { brain, calls } = countingBrain("The API removed the `foo` export.");

  const result = await renderWithBrain(verdict, brain);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.packageName, "some-pkg");
  assert.equal(calls[0]!.fromVersion, "1.0.0");
  assert.equal(calls[0]!.verdictKind, "INCOMPATIBLE");
  assert.match(calls[0]!.output, /TypeError: foo is not a function/);

  assert.match(result, /\*\*Summary:\*\* The API removed the `foo` export\./);
  assert.match(result, /TypeError: foo is not a function/, "raw output must still be present");
});

test("renderWithBrain: brain throws -> falls back to unmodified render() output, does not throw", async () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "FAILED", output: "boom" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);

  const failingBrain: Brain = {
    async summarizeFailure() {
      throw new Error("model unavailable");
    },
  };

  const result = await renderWithBrain(verdict, failingBrain);
  assert.equal(result, render(verdict));
});

test("renderWithBrain: HARNESS_BROKEN summarizes the control's output", async () => {
  const control = version({
    version: "1.0.0",
    status: "FAILED",
    output: "Cannot find module 'some-hoisted-dep'",
  });
  const candidate = version({ version: "1.1.0", status: "PASSED" });
  const r = report({ versions: [control, candidate], control, controlFailed: true });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  const { brain, calls } = countingBrain("A devDependency is missing.");

  const result = await renderWithBrain(verdict, brain);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.output, /Cannot find module/);
  assert.match(result, /A devDependency is missing\./);
});

// --- HTTP wiring for the two Brain implementations, against fake local servers ---

async function withFakeServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("createAnthropicBrain: sends the Messages API shape and parses the text block", async () => {
  let receivedBody: unknown;
  let receivedHeaders: Record<string, string | string[] | undefined> = {};

  await withFakeServer(
    (req, res) => {
      receivedHeaders = req.headers;
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        receivedBody = JSON.parse(raw);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ content: [{ type: "text", text: "  summarized.  " }] }));
      });
    },
    async (baseUrl) => {
      const brain = createAnthropicBrain({ apiKey: "test-key", baseUrl });
      const summary = await brain.summarizeFailure({
        packageName: "pkg",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        verdictKind: "INCOMPATIBLE",
        output: "some failure output",
      });

      assert.equal(summary, "summarized.");
      assert.equal(receivedHeaders["x-api-key"], "test-key");
      assert.equal(receivedHeaders["anthropic-version"], "2023-06-01");
      const body = receivedBody as { messages: Array<{ content: string }> };
      assert.match(body.messages[0]!.content, /some failure output/);
    },
  );
});

test("createAnthropicBrain: non-ok response throws", async () => {
  await withFakeServer(
    (_req, res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    },
    async (baseUrl) => {
      const brain = createAnthropicBrain({ apiKey: "test-key", baseUrl });
      await assert.rejects(
        () =>
          brain.summarizeFailure({
            packageName: "pkg",
            fromVersion: "1.0.0",
            toVersion: "1.1.0",
            verdictKind: "INCOMPATIBLE",
            output: "x",
          }),
        /Anthropic API error 500/,
      );
    },
  );
});

test("createOpenAiCompatibleBrain: sends chat/completions shape and parses message content (works for local Ollama/vLLM too)", async () => {
  let receivedPath = "";
  let receivedHeaders: Record<string, string | string[] | undefined> = {};

  await withFakeServer(
    (req, res) => {
      receivedPath = req.url ?? "";
      receivedHeaders = req.headers;
      let raw = "";
      req.on("data", (chunk) => (raw += chunk));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ choices: [{ message: { content: "local summary" } }] }),
        );
      });
    },
    async (baseUrl) => {
      const brain = createOpenAiCompatibleBrain({
        baseUrl,
        model: "llama3",
      });
      const summary = await brain.summarizeFailure({
        packageName: "pkg",
        fromVersion: null,
        toVersion: "1.1.0",
        verdictKind: "HARNESS_BROKEN",
        output: "x",
      });

      assert.equal(summary, "local summary");
      assert.equal(receivedPath, "/chat/completions");
      assert.equal(receivedHeaders["authorization"], undefined, "no apiKey configured -> no auth header, matches local endpoints needing none");
    },
  );
});

test("createOpenAiCompatibleBrain: sends bearer auth when apiKey is configured", async () => {
  let receivedHeaders: Record<string, string | string[] | undefined> = {};

  await withFakeServer(
    (req, res) => {
      receivedHeaders = req.headers;
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
      });
    },
    async (baseUrl) => {
      const brain = createOpenAiCompatibleBrain({
        baseUrl,
        apiKey: "sk-test",
        model: "gpt-4o-mini",
      });
      await brain.summarizeFailure({
        packageName: "pkg",
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
        verdictKind: "INCOMPATIBLE",
        output: "x",
      });
      assert.equal(receivedHeaders["authorization"], "Bearer sk-test");
    },
  );
});
