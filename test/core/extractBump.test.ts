import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { extractBump, isUnsupported } from "../../src/core/extractBump.ts";

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}

async function writePackageJson(
  repoDir: string,
  deps: Record<string, unknown>,
): Promise<void> {
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify(deps, null, 2),
  );
}

async function makeRepo(): Promise<string> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-test-"));
  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@test.local"]);
  await git(repoDir, ["config", "user.name", "test"]);
  return repoDir;
}

async function commit(repoDir: string, message: string): Promise<void> {
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", message]);
}

test("extractBump: single dependency version bump", async () => {
  const repoDir = await makeRepo();
  try {
    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.0.0", lodash: "4.17.21" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.1.0", lodash: "4.17.21" },
    });
    await commit(repoDir, "bump commander");

    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
    });

    assert.equal(isUnsupported(result), false);
    if (!isUnsupported(result)) {
      assert.deepEqual(result, {
        name: "commander",
        fromVersion: "11.0.0",
        toVersion: "11.1.0",
        section: "dependencies",
        packageJsonPath: "package.json",
      });
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: grouped bump with DIFFERING target versions returns Unsupported with all bumps listed", async () => {
  const repoDir = await makeRepo();
  try {
    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.0.0", lodash: "4.17.20" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.1.0", lodash: "4.17.21" },
    });
    await commit(repoDir, "grouped bump");

    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
    });

    assert.equal(isUnsupported(result), true);
    if (isUnsupported(result)) {
      assert.equal(result.bumps.length, 2);
      assert.match(result.reason, /Grouped update/);
      assert.match(result.reason, /DIFFERING target versions/);
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: grouped bump with the SAME target version is supported — one primary, the rest become group", async () => {
  const repoDir = await makeRepo();
  try {
    await writePackageJson(repoDir, {
      name: "app",
      dependencies: {
        "@nestjs/core": "11.0.0",
        "@nestjs/common": "11.0.0",
        "@nestjs/platform-express": "11.0.0",
      },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writePackageJson(repoDir, {
      name: "app",
      dependencies: {
        "@nestjs/core": "11.2.3",
        "@nestjs/common": "11.2.3",
        "@nestjs/platform-express": "11.2.3",
      },
    });
    await commit(repoDir, "grouped bump, same target version");

    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
    });

    assert.equal(isUnsupported(result), false);
    if (!isUnsupported(result)) {
      // Deterministic primary selection: sorted by name, not insertion
      // order — @nestjs/common sorts before @nestjs/core and
      // @nestjs/platform-express.
      assert.equal(result.name, "@nestjs/common");
      assert.equal(result.fromVersion, "11.0.0");
      assert.equal(result.toVersion, "11.2.3");
      assert.deepEqual(result.group, ["@nestjs/core", "@nestjs/platform-express"]);
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: no version change returns Unsupported", async () => {
  const repoDir = await makeRepo();
  try {
    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.0.0" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writePackageJson(repoDir, {
      name: "app",
      description: "unrelated change",
      dependencies: { commander: "11.0.0" },
    });
    await commit(repoDir, "unrelated change");

    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
    });

    assert.equal(isUnsupported(result), true);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: newly added dependency is not treated as a bump", async () => {
  const repoDir = await makeRepo();
  try {
    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.0.0" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { commander: "11.0.0", zod: "3.22.0" },
    });
    await commit(repoDir, "add zod");

    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
    });

    assert.equal(isUnsupported(result), true);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: workspace: specifier bump is ignored (not a registry version)", async () => {
  const repoDir = await makeRepo();
  try {
    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { "@myorg/lib": "workspace:*" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writePackageJson(repoDir, {
      name: "app",
      dependencies: { "@myorg/lib": "workspace:^1.0.0" },
    });
    await commit(repoDir, "workspace change");

    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
    });

    assert.equal(isUnsupported(result), true);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

// --- auto-discovery: no packageJsonPath given, more than one package.json exists in the repo ---

async function writeFileAt(
  repoDir: string,
  relativePath: string,
  content: unknown,
): Promise<void> {
  const { mkdir, writeFile: write } = await import("node:fs/promises");
  await mkdir(path.dirname(path.join(repoDir, relativePath)), { recursive: true });
  await write(path.join(repoDir, relativePath), JSON.stringify(content, null, 2));
}

test("extractBump: auto-discovery finds the bump in a workspace member when root package.json has no deps", async () => {
  const repoDir = await makeRepo();
  try {
    await writeFileAt(repoDir, "package.json", {
      name: "monorepo-root",
      private: true,
      workspaces: ["packages/*"],
    });
    await writeFileAt(repoDir, "packages/api/package.json", {
      name: "@fixture/api",
      dependencies: { express: "4.18.2" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writeFileAt(repoDir, "packages/api/package.json", {
      name: "@fixture/api",
      dependencies: { express: "4.19.0" },
    });
    await commit(repoDir, "bump express in api");

    const result = await extractBump({ repoDir, baseRef: "base", headRef: "HEAD" });

    assert.equal(isUnsupported(result), false);
    if (!isUnsupported(result)) {
      assert.deepEqual(result, {
        name: "express",
        fromVersion: "4.18.2",
        toVersion: "4.19.0",
        section: "dependencies",
        packageJsonPath: "packages/api/package.json",
      });
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: auto-discovery picks the ONE workspace member that changed, ignoring unchanged siblings", async () => {
  const repoDir = await makeRepo();
  try {
    await writeFileAt(repoDir, "package.json", {
      name: "monorepo-root",
      private: true,
      workspaces: ["packages/*"],
    });
    await writeFileAt(repoDir, "packages/api/package.json", {
      name: "@fixture/api",
      dependencies: { express: "4.18.2" },
    });
    await writeFileAt(repoDir, "packages/worker/package.json", {
      name: "@fixture/worker",
      dependencies: { express: "4.18.2" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    // Only packages/worker changes on this PR — packages/api is untouched,
    // matching how Dependabot opens a SEPARATE PR per tracked directory.
    await writeFileAt(repoDir, "packages/worker/package.json", {
      name: "@fixture/worker",
      dependencies: { express: "4.19.0" },
    });
    await commit(repoDir, "bump express in worker only");

    const result = await extractBump({ repoDir, baseRef: "base", headRef: "HEAD" });

    assert.equal(isUnsupported(result), false);
    if (!isUnsupported(result)) {
      assert.equal(result.packageJsonPath, "packages/worker/package.json");
      assert.equal(result.fromVersion, "4.18.2");
      assert.equal(result.toVersion, "4.19.0");
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: bumps in two different package.json files at once -> Unsupported grouped, listing both", async () => {
  const repoDir = await makeRepo();
  try {
    await writeFileAt(repoDir, "package.json", {
      name: "monorepo-root",
      private: true,
      workspaces: ["packages/*"],
    });
    await writeFileAt(repoDir, "packages/api/package.json", {
      name: "@fixture/api",
      dependencies: { express: "4.18.2" },
    });
    await writeFileAt(repoDir, "packages/worker/package.json", {
      name: "@fixture/worker",
      dependencies: { express: "4.18.2" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    await writeFileAt(repoDir, "packages/api/package.json", {
      name: "@fixture/api",
      dependencies: { express: "4.19.0" },
    });
    await writeFileAt(repoDir, "packages/worker/package.json", {
      name: "@fixture/worker",
      dependencies: { express: "4.19.0" },
    });
    await commit(repoDir, "bump express in both");

    const result = await extractBump({ repoDir, baseRef: "base", headRef: "HEAD" });

    assert.equal(isUnsupported(result), true);
    if (isUnsupported(result)) {
      assert.equal(result.bumps.length, 2);
      const paths = result.bumps.map((b) => b.packageJsonPath).sort();
      assert.deepEqual(paths, ["packages/api/package.json", "packages/worker/package.json"]);
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: explicit packageJsonPath override restricts scanning to that one file, ignoring a bump elsewhere", async () => {
  const repoDir = await makeRepo();
  try {
    await writeFileAt(repoDir, "package.json", {
      name: "monorepo-root",
      private: true,
      workspaces: ["packages/*"],
    });
    await writeFileAt(repoDir, "packages/api/package.json", {
      name: "@fixture/api",
      dependencies: { express: "4.18.2" },
    });
    await writeFileAt(repoDir, "packages/worker/package.json", {
      name: "@fixture/worker",
      dependencies: { express: "4.18.2" },
    });
    await commit(repoDir, "base");
    await git(repoDir, ["branch", "base"]);

    // Only worker changes...
    await writeFileAt(repoDir, "packages/worker/package.json", {
      name: "@fixture/worker",
      dependencies: { express: "4.19.0" },
    });
    await commit(repoDir, "bump express in worker only");

    // ...but the caller explicitly pins scanning to api, which has no
    // change — must report Unsupported (no change found there), NOT fall
    // back to discovering worker's bump.
    const result = await extractBump({
      repoDir,
      baseRef: "base",
      headRef: "HEAD",
      packageJsonPath: "packages/api/package.json",
    });

    assert.equal(isUnsupported(result), true);
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});
