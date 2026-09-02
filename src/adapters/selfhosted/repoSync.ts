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
 * Turns an auth header ("Authorization: Basic ...") into env vars that
 * apply it to a single git invocation only, via GIT_CONFIG_COUNT/KEY/VALUE
 * (git >= 2.31) rather than `-c http.extraHeader=...` on argv. An argv
 * credential is visible to any local process listing (`ps`) for as long as
 * the git child runs, AND gets echoed verbatim into Node's execFile
 * rejection message on failure (see redactAuthHeader below — that catches
 * the second half, this fixes the first). Deliberately NOT baked into the
 * remote URL either (`https://token@host/...`) — that form gets persisted
 * verbatim into `.git/config` on the very first clone, leaving a long-lived
 * plaintext credential sitting in the clone dir. Env vars are process-local
 * and never written to disk or exposed in argv.
 */
function authEnv(authHeader: string | undefined): NodeJS.ProcessEnv {
  if (!authHeader) return {};
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: authHeader,
  };
}

/**
 * Node's execFile rejects with an error whose `.message`/`.cmd` embed the
 * full argv it ran — harmless now that the credential isn't ON that argv
 * (see authEnv above), but kept as defense in depth in case a future
 * change reintroduces an argv-based credential.
 */
interface MaybeExecException {
  message: string;
  cmd?: string | undefined;
}

function redactAuthHeader<E>(error: E, authHeader: string | undefined): E {
  if (!authHeader || !(error instanceof Error)) return error;
  const withCmd = error as Error & MaybeExecException;
  withCmd.message = withCmd.message.split(authHeader).join("[REDACTED]");
  if (withCmd.cmd) withCmd.cmd = withCmd.cmd.split(authHeader).join("[REDACTED]");
  return error;
}

async function runGit(
  args: string[],
  authHeader: string | undefined,
  options?: { cwd: string },
): Promise<void> {
  try {
    await execFileAsync("git", args, {
      ...options,
      env: { ...process.env, ...authEnv(authHeader) },
    });
  } catch (error) {
    throw redactAuthHeader(error, authHeader);
  }
}

/**
 * Clones the target repo into cloneDir if it isn't there yet, else fetches
 * to update it. When a clone already exists, `origin` is reset to
 * `remoteUrl` before fetching — reusing a clone dir after REPO/PROVIDER
 * changed (or pointing this at a pre-existing clone of something else)
 * would otherwise silently send the NEW credential to whatever host is
 * currently configured as `origin`, and fetch the wrong repo's history
 * into what the caller thinks is the target repo's clone.
 */
export async function ensureLocalClone(options: {
  cloneDir: string;
  remoteUrl: string;
  /** e.g. "Authorization: Basic <base64>" — see authEnv's doc comment for why this isn't just embedded in remoteUrl. */
  authHeader?: string | undefined;
}): Promise<void> {
  const hasGitDir = await exists(path.join(options.cloneDir, ".git"));
  if (!hasGitDir) {
    await runGit(["clone", options.remoteUrl, options.cloneDir], options.authHeader);
  } else {
    await runGit(["remote", "set-url", "origin", options.remoteUrl], options.authHeader, {
      cwd: options.cloneDir,
    });
    await runGit(["fetch", "origin"], options.authHeader, { cwd: options.cloneDir });
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
  await runGit(["fetch", "origin", branch], authHeader, { cwd: cloneDir });
}
