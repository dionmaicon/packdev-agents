import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  detectPackageManager,
  installCommand,
} from "../../src/core/prepareWorkspace.ts";

async function makeDir(
  files: Record<string, string>,
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-detect-"));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(dir, name), content);
  }
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function pkgJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ name: "fixture", version: "1.0.0", ...extra });
}

// --- detectPackageManager: "packageManager" field takes precedence ---

test('detectPackageManager: "packageManager" field "yarn@..." wins even with no lockfile', async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson({ packageManager: "yarn@4.14.1" }),
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "yarn");
  } finally {
    await cleanup();
  }
});

test('detectPackageManager: "packageManager" field "pnpm@..." wins even with a yarn.lock present', async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson({ packageManager: "pnpm@9.15.9" }),
    "yarn.lock": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "pnpm");
  } finally {
    await cleanup();
  }
});

test('detectPackageManager: unrecognized "packageManager" field value falls back to lockfile detection', async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson({ packageManager: "bun@1.0.0" }),
    "yarn.lock": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "yarn");
  } finally {
    await cleanup();
  }
});

// --- detectPackageManager: lockfile-based fallback, in precedence order ---

test("detectPackageManager: pnpm-lock.yaml alone -> pnpm", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson(),
    "pnpm-lock.yaml": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "pnpm");
  } finally {
    await cleanup();
  }
});

test("detectPackageManager: yarn.lock alone -> yarn", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson(),
    "yarn.lock": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "yarn");
  } finally {
    await cleanup();
  }
});

test("detectPackageManager: pnpm-lock.yaml AND yarn.lock both present -> pnpm wins (matches source precedence)", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson(),
    "pnpm-lock.yaml": "",
    "yarn.lock": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "pnpm");
  } finally {
    await cleanup();
  }
});

test("detectPackageManager: no field, no lockfile -> defaults to npm", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson(),
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "npm");
  } finally {
    await cleanup();
  }
});

test("detectPackageManager: package-lock.json present -> still npm (npm has no dedicated detection branch, it's the default)", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson(),
    "package-lock.json": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "npm");
  } finally {
    await cleanup();
  }
});

test("detectPackageManager: missing package.json falls back to lockfile detection instead of throwing", async () => {
  const { dir, cleanup } = await makeDir({
    "yarn.lock": "",
  });
  try {
    assert.equal(await detectPackageManager(dir, "package.json"), "yarn");
  } finally {
    await cleanup();
  }
});

// --- installCommand: frozen-lockfile vs. fresh-install branching ---

test("installCommand: npm + package-lock.json -> ci", async () => {
  const { dir, cleanup } = await makeDir({ "package-lock.json": "" });
  try {
    assert.deepEqual(await installCommand("npm", dir), {
      command: "npm",
      args: ["ci", "--no-audit", "--no-fund"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: npm + no lockfile -> install", async () => {
  const { dir, cleanup } = await makeDir({});
  try {
    assert.deepEqual(await installCommand("npm", dir), {
      command: "npm",
      args: ["install", "--no-audit", "--no-fund"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: yarn + yarn.lock -> install --frozen-lockfile", async () => {
  const { dir, cleanup } = await makeDir({ "yarn.lock": "" });
  try {
    assert.deepEqual(await installCommand("yarn", dir), {
      command: "yarn",
      args: ["install", "--frozen-lockfile"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: yarn + no lockfile -> install (not frozen, nothing to freeze against)", async () => {
  const { dir, cleanup } = await makeDir({});
  try {
    assert.deepEqual(await installCommand("yarn", dir), {
      command: "yarn",
      args: ["install"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: pnpm + pnpm-lock.yaml -> install --frozen-lockfile", async () => {
  const { dir, cleanup } = await makeDir({ "pnpm-lock.yaml": "" });
  try {
    assert.deepEqual(await installCommand("pnpm", dir), {
      command: "pnpm",
      args: ["install", "--frozen-lockfile"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: pnpm + no lockfile -> install (not frozen)", async () => {
  const { dir, cleanup } = await makeDir({});
  try {
    assert.deepEqual(await installCommand("pnpm", dir), {
      command: "pnpm",
      args: ["install"],
    });
  } finally {
    await cleanup();
  }
});
