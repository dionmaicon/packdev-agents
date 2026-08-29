import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm, access, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { prepareWorkspace } from "../../src/core/prepareWorkspace.ts";
import { runCompat } from "../../src/core/runCompat.ts";

const execFileAsync = promisify(execFile);

async function git(repoDir: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoDir });
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds a git repo whose "base" branch was actually installed with the
 * real package manager (yarn or pnpm), so it carries a real lockfile —
 * the same lockfile prepareWorkspace's own real install will honor with
 * --frozen-lockfile. Runs a real install twice: once here to generate the
 * lockfile fixture, once inside prepareWorkspace itself (the thing under
 * test) — that duplication is intentional, it's what proves the generated
 * lockfile is one prepareWorkspace can actually consume, not just a fixture
 * that happens to parse.
 */
async function makeRepoWithLockfile(
  pm: "yarn" | "pnpm",
  deps: Record<string, string>,
): Promise<{ repoDir: string; cleanup: () => Promise<void> }> {
  const repoDir = await mkdtemp(path.join(tmpdir(), `packdev-agents-repo-${pm}-`));
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: deps }, null, 2),
  );

  if (pm === "yarn") {
    // Berry defaults to PnP; force node_modules so packdev's own control
    // resolution (which walks node_modules) has something to find.
    await writeFile(path.join(repoDir, ".yarnrc.yml"), "nodeLinker: node-modules\n");
    await execFileAsync("yarn", ["install"], { cwd: repoDir });
  } else {
    await execFileAsync("pnpm", ["install"], { cwd: repoDir });
  }

  await rm(path.join(repoDir, "node_modules"), { recursive: true, force: true });

  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@test.local"]);
  await git(repoDir, ["config", "user.name", "test"]);
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "base"]);
  await git(repoDir, ["branch", "base"]);

  return {
    repoDir,
    cleanup: () => rm(repoDir, { recursive: true, force: true }),
  };
}

async function makeRepoAt(baseDeps: Record<string, string>): Promise<{
  repoDir: string;
  cleanup: () => Promise<void>;
}> {
  const repoDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-repo-"));
  await git(repoDir, ["init", "-q"]);
  await git(repoDir, ["config", "user.email", "test@test.local"]);
  await git(repoDir, ["config", "user.name", "test"]);
  await writeFile(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0", dependencies: baseDeps }, null, 2),
  );
  await git(repoDir, ["add", "-A"]);
  await git(repoDir, ["commit", "-q", "-m", "base"]);
  await git(repoDir, ["branch", "base"]);
  return {
    repoDir,
    cleanup: () => rm(repoDir, { recursive: true, force: true }),
  };
}

test("prepareWorkspace: checks out base ref (not head) and installs it", async () => {
  const { repoDir, cleanup: cleanupRepo } = await makeRepoAt({
    "is-odd": "3.0.0",
  });
  try {
    // Simulate the PR head bumping the dependency, after branching "base".
    await writeFile(
      path.join(repoDir, "package.json"),
      JSON.stringify(
        { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
        null,
        2,
      ),
    );
    await git(repoDir, ["add", "-A"]);
    await git(repoDir, ["commit", "-q", "-m", "bump is-odd"]);

    const workspace = await prepareWorkspace({ repoDir, baseRef: "base" });
    try {
      assert.equal(workspace.packageManager, "npm");
      assert.ok(await exists(path.join(workspace.dir, "node_modules", "is-odd")));

      const pkgJson = JSON.parse(
        await (await import("node:fs/promises")).readFile(
          path.join(workspace.dir, "package.json"),
          "utf8",
        ),
      );
      assert.equal(
        pkgJson.dependencies["is-odd"],
        "3.0.0",
        "workspace must reflect base ref's package.json, not head's bumped version",
      );

      const installedVersion = JSON.parse(
        await (await import("node:fs/promises")).readFile(
          path.join(workspace.dir, "node_modules", "is-odd", "package.json"),
          "utf8",
        ),
      ).version;
      assert.equal(installedVersion, "3.0.0");
    } finally {
      await workspace.cleanup();
    }
  } finally {
    await cleanupRepo();
  }
});

test(
  "prepareWorkspace + runCompat: control resolves to the pre-bump version, never the candidate",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup: cleanupRepo } = await makeRepoAt({
      "is-odd": "3.0.0",
    });
    try {
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump is-odd"]);

      const workspace = await prepareWorkspace({ repoDir, baseRef: "base" });
      try {
        const result = await runCompat({
          appDir: workspace.dir,
          packageName: "is-odd",
          versions: ["3.0.1"],
          testCommand:
            'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
        });

        assert.ok(result.report.control, "control must resolve");
        assert.equal(
          result.report.control!.version,
          "3.0.0",
          "control must be the pre-bump version installed from the base ref, not the candidate",
        );
        assert.notEqual(
          result.report.control!.version,
          "3.0.1",
          "control degenerating into the candidate is exactly the failure mode this workspace prep prevents",
        );
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await cleanupRepo();
    }
  },
);

test(
  "prepareWorkspace: yarn.lock repo -> detects yarn, installs via --frozen-lockfile, base ref's version",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup: cleanupRepo } = await makeRepoWithLockfile("yarn", {
      "is-odd": "3.0.0",
    });
    try {
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump is-odd"]);

      const workspace = await prepareWorkspace({ repoDir, baseRef: "base" });
      try {
        assert.equal(workspace.packageManager, "yarn");
        const installedVersion = JSON.parse(
          await readFile(
            path.join(workspace.dir, "node_modules", "is-odd", "package.json"),
            "utf8",
          ),
        ).version;
        assert.equal(
          installedVersion,
          "3.0.0",
          "must install the base ref's lockfile-pinned version, not head's bumped one",
        );
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await cleanupRepo();
    }
  },
);

test(
  "prepareWorkspace: pnpm-lock.yaml repo -> detects pnpm, installs via --frozen-lockfile, base ref's version",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup: cleanupRepo } = await makeRepoWithLockfile("pnpm", {
      "is-odd": "3.0.0",
    });
    try {
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump is-odd"]);

      const workspace = await prepareWorkspace({ repoDir, baseRef: "base" });
      try {
        assert.equal(workspace.packageManager, "pnpm");
        const installedVersion = JSON.parse(
          await readFile(
            path.join(workspace.dir, "node_modules", "is-odd", "package.json"),
            "utf8",
          ),
        ).version;
        assert.equal(
          installedVersion,
          "3.0.0",
          "must install the base ref's lockfile-pinned version, not head's bumped one",
        );
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await cleanupRepo();
    }
  },
);

test(
  "prepareWorkspace + runCompat: yarn repo, control resolves to the pre-bump version",
  { timeout: 120_000 },
  async () => {
    const { repoDir, cleanup: cleanupRepo } = await makeRepoWithLockfile("yarn", {
      "is-odd": "3.0.0",
    });
    try {
      await writeFile(
        path.join(repoDir, "package.json"),
        JSON.stringify(
          { name: "fixture-app", version: "1.0.0", dependencies: { "is-odd": "3.0.1" } },
          null,
          2,
        ),
      );
      await git(repoDir, ["add", "-A"]);
      await git(repoDir, ["commit", "-q", "-m", "bump is-odd"]);

      const workspace = await prepareWorkspace({ repoDir, baseRef: "base" });
      try {
        const result = await runCompat({
          appDir: workspace.dir,
          packageName: "is-odd",
          versions: ["3.0.1"],
          testCommand:
            'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
        });
        assert.ok(result.report.control, "control must resolve");
        assert.equal(result.report.control!.version, "3.0.0");
      } finally {
        await workspace.cleanup();
      }
    } finally {
      await cleanupRepo();
    }
  },
);

test("prepareWorkspace: cleans up its temp dir on install failure", async () => {
  const { repoDir, cleanup: cleanupRepo } = await makeRepoAt({
    "this-package-does-not-exist-xyz-987": "1.0.0",
  });
  try {
    await git(repoDir, ["branch", "-f", "base"]);
    await assert.rejects(() => prepareWorkspace({ repoDir, baseRef: "base" }));
  } finally {
    await cleanupRepo();
  }
});
