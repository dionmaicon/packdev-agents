import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveGitRemote, sameHttpOrigin, readRepoList, repoPathSegment, resolveRepoPaths } from "../../src/cli/index.ts";

test("sameHttpOrigin: identical protocol+host -> true, even with different paths", () => {
  assert.equal(sameHttpOrigin("https://github.com/a/b.git", "https://github.com/c/d.git"), true);
});

test("sameHttpOrigin: different host -> false", () => {
  assert.equal(sameHttpOrigin("https://evil.example.com/a/b.git", "https://github.com/a/b.git"), false);
});

test("sameHttpOrigin: different protocol -> false", () => {
  assert.equal(sameHttpOrigin("http://github.com/a/b.git", "https://github.com/a/b.git"), false);
});

test("sameHttpOrigin: invalid URL -> false, not a throw", () => {
  assert.equal(sameHttpOrigin("not a url", "https://github.com/a/b.git"), false);
});

test("resolveGitRemote: no REMOTE_URL override -> uses provider's own url + authHeader", () => {
  delete process.env["REMOTE_URL"];
  const provider = { createGitRemote: () => ({ url: "https://github.com/a/b.git", authHeader: "Authorization: Basic secret" }) };
  const result = resolveGitRemote(provider);
  assert.equal(result.remoteUrl, "https://github.com/a/b.git");
  assert.equal(result.authHeader, "Authorization: Basic secret");
});

test("resolveGitRemote: REMOTE_URL override on the SAME origin -> authHeader still applied", () => {
  process.env["REMOTE_URL"] = "https://github.com/other/repo.git";
  try {
    const provider = { createGitRemote: () => ({ url: "https://github.com/a/b.git", authHeader: "Authorization: Basic secret" }) };
    const result = resolveGitRemote(provider);
    assert.equal(result.remoteUrl, "https://github.com/other/repo.git");
    assert.equal(result.authHeader, "Authorization: Basic secret");
  } finally {
    delete process.env["REMOTE_URL"];
  }
});

test("resolveGitRemote: REMOTE_URL override on a DIFFERENT origin -> authHeader is dropped, not leaked", () => {
  process.env["REMOTE_URL"] = "https://evil.example.com/a/b.git";
  try {
    const provider = { createGitRemote: () => ({ url: "https://github.com/a/b.git", authHeader: "Authorization: Basic secret" }) };
    const result = resolveGitRemote(provider);
    assert.equal(result.remoteUrl, "https://evil.example.com/a/b.git");
    assert.equal(result.authHeader, undefined);
  } finally {
    delete process.env["REMOTE_URL"];
  }
});

function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(vars)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("readRepoList: REPO alone -> single-element list", () => {
  withEnv({ REPO: "owner/repo", REPOS: undefined }, () => {
    assert.deepEqual(readRepoList(), ["owner/repo"]);
  });
});

test("readRepoList: REPOS alone -> trimmed, comma-split list", () => {
  withEnv({ REPO: undefined, REPOS: " owner/a, owner/b ,owner/c" }, () => {
    assert.deepEqual(readRepoList(), ["owner/a", "owner/b", "owner/c"]);
  });
});

test("readRepoList: both REPO and REPOS set -> throws", () => {
  withEnv({ REPO: "owner/repo", REPOS: "owner/a" }, () => {
    assert.throws(() => readRepoList(), /mutually exclusive/);
  });
});

test("readRepoList: neither set -> throws naming both", () => {
  withEnv({ REPO: undefined, REPOS: undefined }, () => {
    assert.throws(() => readRepoList(), /REPO \(or REPOS/);
  });
});

test("readRepoList: REPOS all-commas -> throws instead of returning an empty list", () => {
  withEnv({ REPO: undefined, REPOS: " , ," }, () => {
    assert.throws(() => readRepoList(), /REPOS must contain at least one/);
  });
});

test("repoPathSegment: sanitizes slashes and other punctuation to underscores", () => {
  assert.equal(repoPathSegment("owner/repo"), "owner_repo");
  assert.equal(repoPathSegment("my-org/my.repo_name"), "my-org_my.repo_name");
});

test("resolveRepoPaths: single repo -> flat single-repo defaults, ignores multi defaults", () => {
  const paths = resolveRepoPaths(
    ["owner/repo"],
    undefined,
    undefined,
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/state" },
  );
  assert.deepEqual(paths.get("owner/repo"), {
    cloneDir: "./.packdev-agents/repo",
    statePath: "./.packdev-agents/state.json",
  });
});

test("resolveRepoPaths: multiple repos -> each gets its own namespaced subdir/file, never sharing a path", () => {
  const paths = resolveRepoPaths(
    ["owner/a", "owner/b"],
    undefined,
    undefined,
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/state" },
  );
  const a = paths.get("owner/a")!;
  const b = paths.get("owner/b")!;
  assert.notEqual(a.cloneDir, b.cloneDir);
  assert.notEqual(a.statePath, b.statePath);
  assert.match(a.cloneDir, /\.packdev-agents\/repos\/owner_a$/);
  assert.match(a.statePath, /\.packdev-agents\/state\/owner_a\.json$/);
});

test("resolveRepoPaths: multiple repos with explicit CLONE_DIR/STATE_PATH -> treated as roots, not literal paths", () => {
  const paths = resolveRepoPaths(
    ["owner/a", "owner/b"],
    "/data/clones",
    "/data/state",
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/state" },
  );
  assert.deepEqual(paths.get("owner/a"), {
    cloneDir: "/data/clones/owner_a",
    statePath: "/data/state/owner_a.json",
  });
});
