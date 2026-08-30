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
      args: ["ci", "--no-audit", "--no-fund", "--ignore-scripts"],
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
      args: ["install", "--no-audit", "--no-fund", "--ignore-scripts"],
    });
  } finally {
    await cleanup();
  }
});

// Yarn classic (v1) needs --ignore-scripts told explicitly (runs scripts
// by default); Yarn Berry (v2+) has no such flag at all — passing it is a
// hard CLI syntax error, and Berry already disables build scripts by
// default anyway. installCommand detects which one via the
// "packageManager" field (or a real `yarn --version` spawn as a
// fallback, not exercised by these fixtures since the field is always
// present here) — see yarnNeedsIgnoreScriptsFlag's doc comment.

test("installCommand: yarn v1 (classic) + yarn.lock -> install --frozen-lockfile --ignore-scripts", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson({ packageManager: "yarn@1.22.22" }),
    "yarn.lock": "",
  });
  try {
    assert.deepEqual(await installCommand("yarn", dir, "package.json"), {
      command: "yarn",
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: yarn v1 (classic) + no lockfile -> install --ignore-scripts (not frozen, nothing to freeze against)", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson({ packageManager: "yarn@1.22.22" }),
  });
  try {
    assert.deepEqual(await installCommand("yarn", dir, "package.json"), {
      command: "yarn",
      args: ["install", "--ignore-scripts"],
    });
  } finally {
    await cleanup();
  }
});

test("installCommand: yarn Berry (v2+) + yarn.lock -> install --frozen-lockfile, NO --ignore-scripts (unsupported flag there, and unnecessary — Berry disables build scripts by default)", async () => {
  const { dir, cleanup } = await makeDir({
    "package.json": pkgJson({ packageManager: "yarn@4.14.1" }),
    "yarn.lock": "",
  });
  try {
    assert.deepEqual(await installCommand("yarn", dir, "package.json"), {
      command: "yarn",
      args: ["install", "--frozen-lockfile"],
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
      args: ["install", "--frozen-lockfile", "--ignore-scripts"],
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
      args: ["install", "--ignore-scripts"],
    });
  } finally {
    await cleanup();
  }
});
