import { test } from "node:test";
import assert from "node:assert/strict";

import { createOctokitOps } from "../../../src/providers/github/ops.js";

/**
 * Minimal fake of the slice of Octokit this file actually touches — enough
 * to exercise createCheckRun's error-swallowing without a real GitHub App
 * token (see live-test finding: a plain PAT gets HttpError "You must
 * authenticate via a GitHub App" from checks.create, every time).
 */
function fakeOctokit(overrides: { checksCreate?: () => Promise<unknown> } = {}) {
  return {
    rest: {
      issues: {
        listComments: async () => [],
        createComment: async () => ({}),
        updateComment: async () => ({}),
      },
      checks: {
        create: overrides.checksCreate ?? (async () => ({})),
      },
      pulls: {
        merge: async () => ({}),
      },
    },
    paginate: async (_fn: unknown, _params: unknown) => [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

test("createCheckRun: a GitHub-App-only failure (HttpError) is caught, not rethrown", async () => {
  const octokit = fakeOctokit({
    checksCreate: async () => {
      throw new Error("HttpError: You must authenticate via a GitHub App.");
    },
  });
  const ops = createOctokitOps({ octokit, owner: "o", repo: "r", prNumber: 1, headSha: "abc" });

  await assert.doesNotReject(
    ops.createCheckRun({ name: "packdev-agents", conclusion: "success", title: "t", summary: "s" }),
  );
});

test("mergePullRequest: pins the merge to the tested headSha via the sha param, so a push during the run can't merge untested code", async () => {
  const octokit = fakeOctokit();
  const calls: unknown[] = [];
  octokit.rest.pulls.merge = async (params: unknown) => {
    calls.push(params);
    return {};
  };
  const ops = createOctokitOps({ octokit, owner: "o", repo: "r", prNumber: 1, headSha: "abc123" });

  await ops.mergePullRequest();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { owner: "o", repo: "r", pull_number: 1, sha: "abc123" });
});

test("upsertComment: still posts even though createCheckRun would fail — comment is the primary output, not gated on checks working", async () => {
  const created: string[] = [];
  const octokit = fakeOctokit();
  octokit.rest.issues.createComment = async (params: { body: string }) => {
    created.push(params.body);
    return {};
  };
  const ops = createOctokitOps({ octokit, owner: "o", repo: "r", prNumber: 1, headSha: "abc" });

  await ops.upsertComment({ marker: "<!-- packdev-agents -->", body: "<!-- packdev-agents -->\nverdict" });

  assert.equal(created.length, 1);
});
