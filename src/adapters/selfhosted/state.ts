import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

/** PR number (as a string key) -> the head SHA it was last processed at. */
export type SeenState = Record<string, string>;

interface ErrnoLike {
  code?: string;
}

/**
 * Tracks which PRs have already been processed, and at which head SHA, so a
 * daemon restart doesn't re-comment on PRs it already handled — but DOES
 * reprocess a PR that picked up new commits since the last poll (a
 * different head SHA is exactly the signal that the content changed).
 */
export async function loadSeenState(statePath: string): Promise<SeenState> {
  try {
    const raw = await readFile(statePath, "utf8");
    return JSON.parse(raw) as SeenState;
  } catch (error) {
    if ((error as ErrnoLike).code === "ENOENT") return {};
    throw error;
  }
}

/**
 * Called after each individual PR is processed (see poll.ts), not once at
 * the end of a batch — a crash partway through a poll must not lose
 * progress already made or cause already-handled PRs to be reprocessed.
 */
export async function saveSeenState(
  statePath: string,
  state: SeenState,
): Promise<void> {
  await mkdir(path.dirname(statePath), { recursive: true });
  await writeFile(statePath, JSON.stringify(state, null, 2));
}
