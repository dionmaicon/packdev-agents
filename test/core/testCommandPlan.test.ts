import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { planTestCommand } from "../../src/core/testCommandPlan.ts";

async function fixtureDir(scripts: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-testplan-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("planTestCommand: bare 'npm test' + a real pretest hook -> runs the hook explicitly, with a note", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "tsc -p tsconfig.json", test: "node --test" });
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.equal(plan.testCommand, "npm run pretest && npm run test");
    assert.equal(plan.testScript, undefined);
    assert.match(plan.note!, /pretest/);
    assert.match(plan.note!, /ignore-scripts/);
  } finally {
    await cleanup();
  }
});

test("planTestCommand: a pretest whose body is exactly 'npm run build' expands through to build's OWN prebuild hook", async () => {
  // The real packdev-demo-nestjs shape, plus one more level: expanding only
  // one level would run `npm run pretest`, whose body `npm run build` would
  // itself silently skip `prebuild` — the same bug one level down.
  const { dir, cleanup } = await fixtureDir({
    prebuild: "rimraf dist",
    build: "tsc -p tsconfig.json",
    pretest: "npm run build",
    test: "node --test",
  });
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.equal(plan.testCommand, "npm run prebuild && npm run build && npm run test");
  } finally {
    await cleanup();
  }
});

test("planTestCommand: a pretest with a non-trivial shell body is run by name, not parsed", async () => {
  const { dir, cleanup } = await fixtureDir({
    pretest: "rm -rf dist && tsc && cp -r assets dist/",
    test: "node --test",
  });
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.equal(plan.testCommand, "npm run pretest && npm run test");
  } finally {
    await cleanup();
  }
});

test("planTestCommand: post-hooks are restored too, after the script itself", async () => {
  const { dir, cleanup } = await fixtureDir({ test: "node --test", posttest: "node scripts/coverage-report.js" });
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.equal(plan.testCommand, "npm run test && npm run posttest");
  } finally {
    await cleanup();
  }
});

test("planTestCommand: no lifecycle hooks -> passes the caller's config through completely untouched", async () => {
  const { dir, cleanup } = await fixtureDir({ test: "node --test" });
  try {
    const fromCommand = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.equal(fromCommand.testCommand, "npm test");
    assert.equal(fromCommand.note, null);

    // testScript is preserved AS testScript here — converting it would cost
    // packdev's own harness-caveat detection for no benefit.
    const fromScript = await planTestCommand(dir, { testScript: "test" }, "npm");
    assert.equal(fromScript.testScript, "test");
    assert.equal(fromScript.testCommand, undefined);
    assert.equal(fromScript.note, null);
  } finally {
    await cleanup();
  }
});

test("planTestCommand: testScript + hooks -> converts to a chained command and says so, including the caveat-detection tradeoff", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", build: "tsc", test: "node --test" });
  try {
    const plan = await planTestCommand(dir, { testScript: "test" }, "npm");
    assert.equal(plan.testCommand, "npm run build && npm run test");
    assert.equal(plan.testScript, undefined);
    assert.match(plan.note!, /TYPE_CHECK_ONLY/);
  } finally {
    await cleanup();
  }
});

test("planTestCommand: an already-chained testCommand is never rewritten — the user owns that sequence", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", build: "tsc", test: "node --test" });
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm run build && npm test" }, "npm");
    assert.equal(plan.testCommand, "npm run build && npm test");
    assert.equal(plan.note, null);
  } finally {
    await cleanup();
  }
});

test("planTestCommand: uses the detected package manager, not a hardcoded npm", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "tsc", test: "node --test" });
  try {
    const plan = await planTestCommand(dir, { testCommand: "pnpm test" }, "pnpm");
    assert.equal(plan.testCommand, "pnpm run pretest && pnpm run test");
  } finally {
    await cleanup();
  }
});

test("planTestCommand: a self-referential hook cycle terminates instead of hanging", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run test", test: "node --test" });
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.ok(plan.testCommand!.includes("npm run test"));
  } finally {
    await cleanup();
  }
});

test("planTestCommand: missing package.json -> passthrough, no throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-testplan-empty-"));
  try {
    const plan = await planTestCommand(dir, { testCommand: "npm test" }, "npm");
    assert.equal(plan.testCommand, "npm test");
    assert.equal(plan.note, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
