import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Clones the target repo into cloneDir if it isn't there yet, else fetches to update it. */
export async function ensureLocalClone(options: {
  cloneDir: string;
  remoteUrl: string;
}): Promise<void> {
  const hasGitDir = await exists(path.join(options.cloneDir, ".git"));
  if (!hasGitDir) {
    await execFileAsync("git", ["clone", options.remoteUrl, options.cloneDir]);
  } else {
    await execFileAsync("git", ["fetch", "origin"], { cwd: options.cloneDir });
  }
}

/**
 * Fetches a branch by name into the local clone's object database. Uses a
 * plain branch-name fetch (not GitHub's `pull/<n>/head` convention) so this
 * works against any git remote, including a local one in tests — the PR
 * API response already gives us both base.ref/head.ref (branch names) and
 * base.sha/head.sha (exact commits), and it's the exact SHAs that get
 * passed on to extractBump/prepareWorkspace, so a branch moving between
 * this fetch and that read doesn't matter.
 */
export async function fetchBranch(cloneDir: string, branch: string): Promise<void> {
  await execFileAsync("git", ["fetch", "origin", branch], { cwd: cloneDir });
}
