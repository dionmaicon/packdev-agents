import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ensureLocalClone, fetchBranch } from "../../../src/adapters/selfhosted/repoSync.ts";

const execFileAsync = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: dir });
  return stdout.trim();
}

async function makeSourceRepo(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-remote-"));
  await git(dir, ["init", "-q"]);
  await git(dir, ["config", "user.email", "test@test.local"]);
  await git(dir, ["config", "user.name", "test"]);
  await writeFile(path.join(dir, "file.txt"), "v1");
  await git(dir, ["add", "-A"]);
  await git(dir, ["commit", "-q", "-m", "first"]);
  await git(dir, ["branch", "-M", "main"]);
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("ensureLocalClone: clones when the target dir has no .git, then fetches on a second call", async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = await makeSourceRepo();
  const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-clone-"));
  try {
    await ensureLocalClone({ cloneDir, remoteUrl: remoteDir });
    const headAfterClone = await git(cloneDir, ["rev-parse", "HEAD"]);
    const remoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);
    assert.equal(headAfterClone, remoteHead);

    // New commit on the remote after the clone.
    await writeFile(path.join(remoteDir, "file.txt"), "v2");
    await git(remoteDir, ["add", "-A"]);
    await git(remoteDir, ["commit", "-q", "-m", "second"]);
    const newRemoteHead = await git(remoteDir, ["rev-parse", "HEAD"]);

    // Second call must fetch (not re-clone, and not error on an existing dir).
    await ensureLocalClone({ cloneDir, remoteUrl: remoteDir });
    const fetchedMainSha = await git(cloneDir, [
      "rev-parse",
      "refs/remotes/origin/main",
    ]);
    assert.equal(fetchedMainSha, newRemoteHead);
  } finally {
    await cleanupRemote();
    await rm(cloneDir, { recursive: true, force: true });
  }
});

test("fetchBranch: pulls a branch created on the remote AFTER the initial clone", async () => {
  const { dir: remoteDir, cleanup: cleanupRemote } = await makeSourceRepo();
  const cloneDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-clone-"));
  try {
    // Clone happens first, while only "main" exists on the remote — this
    // is poll.ts's actual scenario: the local clone was made earlier, and
    // a PR branch shows up on the remote later, between polls.
    await ensureLocalClone({ cloneDir, remoteUrl: remoteDir });

    await git(remoteDir, ["checkout", "-q", "-b", "feature"]);
    await writeFile(path.join(remoteDir, "file.txt"), "feature-content");
    await git(remoteDir, ["add", "-A"]);
    await git(remoteDir, ["commit", "-q", "-m", "feature commit"]);
    const featureSha = await git(remoteDir, ["rev-parse", "feature"]);

    await fetchBranch(cloneDir, "feature");

    const content = await git(cloneDir, ["show", `${featureSha}:file.txt`]);
    assert.equal(content, "feature-content");
  } finally {
    await cleanupRemote();
    await rm(cloneDir, { recursive: true, force: true });
  }
});
