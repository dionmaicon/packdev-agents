import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveGitRemote, sameHttpOrigin } from "../../src/cli/index.ts";

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
