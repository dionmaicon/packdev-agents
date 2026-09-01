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

/**
 * Turns an auth header ("Authorization: Basic ...") into the `-c` args that
 * apply it to a single git invocation only. Deliberately NOT baked into the
 * remote URL (`https://token@host/...`) — that form gets persisted verbatim
 * into `.git/config` on the very first clone, leaving a long-lived plaintext
 * credential sitting in the clone dir. `-c http.extraHeader` is a per-
 * process override; it's applied fresh on every clone/fetch call and is
 * never written to disk.
 */
function authArgs(authHeader: string | undefined): string[] {
  return authHeader ? ["-c", `http.extraHeader=${authHeader}`] : [];
}

/** Clones the target repo into cloneDir if it isn't there yet, else fetches to update it. */
export async function ensureLocalClone(options: {
  cloneDir: string;
  remoteUrl: string;
  /** e.g. "Authorization: Basic <base64>" — see authArgs's doc comment for why this isn't just embedded in remoteUrl. */
  authHeader?: string | undefined;
}): Promise<void> {
  const hasGitDir = await exists(path.join(options.cloneDir, ".git"));
  const extraArgs = authArgs(options.authHeader);
  if (!hasGitDir) {
    await execFileAsync("git", [...extraArgs, "clone", options.remoteUrl, options.cloneDir]);
  } else {
    await execFileAsync("git", [...extraArgs, "fetch", "origin"], { cwd: options.cloneDir });
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
export async function fetchBranch(cloneDir: string, branch: string, authHeader?: string | undefined): Promise<void> {
  await execFileAsync("git", [...authArgs(authHeader), "fetch", "origin", branch], { cwd: cloneDir });
}
