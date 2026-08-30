import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { detectSilentPretestSkip } from "../../src/core/testCommandGuard.ts";

async function fixtureDir(scripts: Record<string, string>): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-testcmdguard-"));
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ name: "fixture", scripts }, null, 2));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("detectSilentPretestSkip: bare testCommand 'npm test' + a real pretest script -> flags it", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", test: "node --test" });
  try {
    const message = await detectSilentPretestSkip(dir, { testCommand: "npm test" });
    assert.ok(message);
    assert.match(message!, /"pretest"/);
    assert.match(message!, /npm run build/);
    assert.match(message!, /testCommand: "npm test"/);
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: testScript 'test' + a real pretest script -> flags it", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "tsc", test: "node --test" });
  try {
    const message = await detectSilentPretestSkip(dir, { testScript: "test" });
    assert.ok(message);
    assert.match(message!, /testScript: "test"/);
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: testCommand already chains the build explicitly -> not flagged", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", test: "node --test" });
  try {
    const message = await detectSilentPretestSkip(dir, { testCommand: "npm run build && npm test" });
    assert.equal(message, null);
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: no pretest script defined -> not flagged", async () => {
  const { dir, cleanup } = await fixtureDir({ test: "node --test" });
  try {
    const message = await detectSilentPretestSkip(dir, { testCommand: "npm test" });
    assert.equal(message, null);
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: pretest exists but a DIFFERENT script is configured -> not flagged", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", test: "node --test", "test:e2e": "node --test e2e" });
  try {
    const message = await detectSilentPretestSkip(dir, { testCommand: "npm run test:e2e" });
    assert.equal(message, null);
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: yarn/pnpm bare invocations are recognized too", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", test: "node --test" });
  try {
    assert.ok(await detectSilentPretestSkip(dir, { testCommand: "yarn test" }));
    assert.ok(await detectSilentPretestSkip(dir, { testCommand: "yarn run test" }));
    assert.ok(await detectSilentPretestSkip(dir, { testCommand: "pnpm test" }));
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: arbitrary non-package-manager testCommand -> not flagged (can't determine the target script)", async () => {
  const { dir, cleanup } = await fixtureDir({ pretest: "npm run build", test: "node --test" });
  try {
    const message = await detectSilentPretestSkip(dir, { testCommand: "node --test" });
    assert.equal(message, null);
  } finally {
    await cleanup();
  }
});

test("detectSilentPretestSkip: missing package.json -> not flagged, no throw", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-testcmdguard-empty-"));
  try {
    const message = await detectSilentPretestSkip(dir, { testCommand: "npm test" });
    assert.equal(message, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
