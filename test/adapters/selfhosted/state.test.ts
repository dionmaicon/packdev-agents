import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadSeenState, saveSeenState } from "../../../src/adapters/selfhosted/state.ts";

test("loadSeenState: missing file -> empty state, not an error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-state-"));
  try {
    const state = await loadSeenState(path.join(dir, "does-not-exist.json"));
    assert.deepEqual(state, {});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSeenState + loadSeenState: round-trips, creates parent dirs as needed", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-state-"));
  try {
    const statePath = path.join(dir, "nested", "state.json");
    await saveSeenState(statePath, { "42": "abc123" });
    const reloaded = await loadSeenState(statePath);
    assert.deepEqual(reloaded, { "42": "abc123" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("saveSeenState: overwrites the previous state, doesn't merge", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-state-"));
  try {
    const statePath = path.join(dir, "state.json");
    await saveSeenState(statePath, { "1": "aaa" });
    await saveSeenState(statePath, { "2": "bbb" });
    const reloaded = await loadSeenState(statePath);
    assert.deepEqual(reloaded, { "2": "bbb" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
