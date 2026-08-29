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
      });
    }
  } finally {
    await rm(repoDir, { recursive: true, force: true });
  }
});

test("extractBump: grouped bump returns Unsupported with all bumps listed", async () => {
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
