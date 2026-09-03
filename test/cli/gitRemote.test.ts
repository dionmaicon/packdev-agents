import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  resolveGitRemote,
  sameHttpOrigin,
  readRepoList,
  repoPathSegment,
  resolveRepoPaths,
  readCommonEnv,
  throwOnRunFailure,
} from "../../src/cli/index.ts";

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

test("repoPathSegment: filesystem-safe (base64url alphabet only)", () => {
  assert.match(repoPathSegment("owner/repo"), /^[A-Za-z0-9_-]+$/);
  assert.match(repoPathSegment("my-org/my.repo_name"), /^[A-Za-z0-9_-]+$/);
});

test("repoPathSegment: injective — round-trips back to the original repo string", () => {
  for (const repo of ["owner/repo", "my-org/my.repo_name", "a/b_c", "a_b/c"]) {
    const segment = repoPathSegment(repo);
    assert.equal(Buffer.from(segment, "base64url").toString("utf8"), repo);
  }
});

test("repoPathSegment: the real collision a naive '_'-replacement sanitizer hits — \"a/b_c\" and \"a_b/c\" must NOT produce the same segment", () => {
  assert.notEqual(repoPathSegment("a/b_c"), repoPathSegment("a_b/c"));
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
  const segment = repoPathSegment("owner/a");
  assert.equal(a.cloneDir, path.join("./.packdev-agents/repos", segment));
  assert.equal(a.statePath, path.join("./.packdev-agents/state", `${segment}.json`));
});

test("resolveRepoPaths: colliding-under-naive-sanitization repos get DISTINCT paths", () => {
  const paths = resolveRepoPaths(
    ["a/b_c", "a_b/c"],
    undefined,
    undefined,
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/state" },
  );
  const first = paths.get("a/b_c")!;
  const second = paths.get("a_b/c")!;
  assert.notEqual(first.cloneDir, second.cloneDir);
  assert.notEqual(first.statePath, second.statePath);
});

test("resolveRepoPaths: multiple repos with explicit CLONE_DIR/STATE_PATH -> treated as roots, not literal paths", () => {
  const paths = resolveRepoPaths(
    ["owner/a", "owner/b"],
    "/data/clones",
    "/data/state",
    { cloneDir: "./.packdev-agents/repo", statePath: "./.packdev-agents/state.json" },
    { cloneDir: "./.packdev-agents/repos", statePath: "./.packdev-agents/state" },
  );
  const segment = repoPathSegment("owner/a");
  assert.deepEqual(paths.get("owner/a"), {
    cloneDir: `/data/clones/${segment}`,
    statePath: `/data/state/${segment}.json`,
  });
});

test("readCommonEnv: PROVIDER=github, no ALLOWED_ACTORS -> falls through to core's plain default (undefined here, resolved downstream)", () => {
  withEnv({ ALLOWED_ACTORS: undefined, PROVIDER: "github" }, () => {
    assert.equal(readCommonEnv().allowedActors, undefined);
  });
});

test("readCommonEnv: PROVIDER=gitea, no ALLOWED_ACTORS -> defaults ALSO include bare \"renovate\" (Gitea's actor field has no [bot] suffix)", () => {
  withEnv({ ALLOWED_ACTORS: undefined, PROVIDER: "gitea" }, () => {
    const actors = readCommonEnv().allowedActors;
    assert.ok(actors);
    assert.ok(actors!.includes("dependabot[bot]"));
    assert.ok(actors!.includes("renovate[bot]"));
    assert.ok(actors!.includes("renovate"));
  });
});

test("readCommonEnv: PROVIDER=gitea WITH an explicit ALLOWED_ACTORS -> the explicit value wins, no bare \"renovate\" silently added", () => {
  withEnv({ ALLOWED_ACTORS: "dionmaicon", PROVIDER: "gitea" }, () => {
    assert.deepEqual(readCommonEnv().allowedActors, ["dionmaicon"]);
  });
});

// throwOnRunFailure is what --webhook mode's run() closures wrap
// runCompatForRepo/runTriageForRepo in — createWebhookServer's coalescer
// only retries a run() that REJECTS, but runCompatForRepo/runTriageForRepo
// themselves catch every failure and report it in the returned outcome
// instead of throwing (that's the right shape for --once/loop, which just
// logs it). Without this translation, a webhook-triggered failure would be
// silently swallowed — logged once, never retried.
test("throwOnRunFailure: ok:false outcome -> throws the original error", () => {
  const error = new Error("clone failed");
  assert.throws(() => throwOnRunFailure({ repo: "owner/repo", ok: false, error }), /clone failed/);
});

test("throwOnRunFailure: ok:false outcome with a non-Error error value -> still throws, wrapped", () => {
  assert.throws(() => throwOnRunFailure({ repo: "owner/repo", ok: false, error: "some string error" }), /some string error/);
});

test("throwOnRunFailure: ok:true with a non-empty result.failed -> throws", () => {
  const outcome = {
    repo: "owner/repo",
    ok: true as const,
    result: { failed: [{ pr: { number: 1 }, error: new Error("boom") }] },
  };
  assert.throws(() => throwOnRunFailure(outcome), /1 PR\(s\) failed this cycle/);
});

test("throwOnRunFailure: ok:true with an empty result.failed -> does not throw", () => {
  const outcome = { repo: "owner/repo", ok: true as const, result: { failed: [] } };
  assert.doesNotThrow(() => throwOnRunFailure(outcome));
});
