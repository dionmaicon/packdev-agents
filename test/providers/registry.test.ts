import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveProvider } from "../../src/providers/registry.ts";

test("resolveProvider: no PROVIDER set -> defaults to github", async () => {
  const provider = await resolveProvider({ REPO: "o/r", GITHUB_TOKEN: "t" });
  assert.equal(provider.createGitRemote().url, "https://github.com/o/r.git");
});

test("resolveProvider: unknown PROVIDER -> clear error naming the known built-ins", async () => {
  await assert.rejects(
    resolveProvider({ PROVIDER: "bitbucket", REPO: "o/r" }),
    /Unknown PROVIDER "bitbucket".*github, gitea/,
  );
});

test("resolveProvider: PROVIDER_MODULE with a RELATIVE path resolves against process.cwd(), not this file's own location — the real bug this fixes", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-provider-module-"));
  const originalCwd = process.cwd();
  try {
    await writeFile(
      path.join(projectDir, "my-provider.mjs"),
      `export default function createProvider() {
        return {
          createPullRequestSource: () => ({ listOpenBotPRs: async () => [] }),
          createForgeOpsFor: () => ({ upsertComment: async () => {}, createCheckRun: async () => {}, mergePullRequest: async () => {} }),
          createGitRemote: () => ({ url: "https://example.test/custom.git" }),
        };
      }\n`,
    );
    process.chdir(projectDir);

    const provider = await resolveProvider({ PROVIDER_MODULE: "./my-provider.mjs" });
    assert.equal(provider.createGitRemote().url, "https://example.test/custom.git");
  } finally {
    process.chdir(originalCwd);
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolveProvider: PROVIDER_MODULE wins over PROVIDER when both are set", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-provider-module-"));
  const originalCwd = process.cwd();
  try {
    await writeFile(
      path.join(projectDir, "custom.mjs"),
      `export default function createProvider() {
        return {
          createPullRequestSource: () => ({ listOpenBotPRs: async () => [] }),
          createForgeOpsFor: () => ({ upsertComment: async () => {}, createCheckRun: async () => {}, mergePullRequest: async () => {} }),
          createGitRemote: () => ({ url: "https://example.test/wins.git" }),
        };
      }\n`,
    );
    process.chdir(projectDir);

    const provider = await resolveProvider({ PROVIDER: "gitea", PROVIDER_MODULE: "./custom.mjs" });
    assert.equal(provider.createGitRemote().url, "https://example.test/wins.git");
  } finally {
    process.chdir(originalCwd);
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolveProvider: PROVIDER_MODULE with a BARE package specifier resolves from the caller's own node_modules, not this file's own location", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-provider-module-"));
  const originalCwd = process.cwd();
  try {
    const pkgDir = path.join(projectDir, "node_modules", "my-custom-provider-pkg");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "my-custom-provider-pkg", type: "module", main: "index.mjs" }));
    await writeFile(
      path.join(pkgDir, "index.mjs"),
      `export default function createProvider() {
        return {
          createPullRequestSource: () => ({ listOpenBotPRs: async () => [] }),
          createForgeOpsFor: () => ({ upsertComment: async () => {}, createCheckRun: async () => {}, mergePullRequest: async () => {} }),
          createGitRemote: () => ({ url: "https://example.test/bare-specifier.git" }),
        };
      }\n`,
    );
    process.chdir(projectDir);

    const provider = await resolveProvider({ PROVIDER_MODULE: "my-custom-provider-pkg" });
    assert.equal(provider.createGitRemote().url, "https://example.test/bare-specifier.git");
  } finally {
    process.chdir(originalCwd);
    await rm(projectDir, { recursive: true, force: true });
  }
});

test("resolveProvider: PROVIDER_MODULE with no default export, or a non-function default -> clear error", async () => {
  const projectDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-provider-module-"));
  const originalCwd = process.cwd();
  try {
    await writeFile(path.join(projectDir, "bad.mjs"), `export default { notAFunction: true };\n`);
    process.chdir(projectDir);

    await assert.rejects(
      resolveProvider({ PROVIDER_MODULE: "./bad.mjs" }),
      /must have a default export that is a function/,
    );
  } finally {
    process.chdir(originalCwd);
    await rm(projectDir, { recursive: true, force: true });
  }
});
