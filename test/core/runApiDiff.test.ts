import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runApiDiff } from "../../src/core/runApiDiff.ts";
import type { ApiDiffReport } from "../../src/core/packdevTypes.ts";

async function writeFakeBin(dir: string, script: string): Promise<string> {
  const binPath = path.join(dir, "fake-packdev.mjs");
  await writeFile(binPath, script);
  await chmod(binPath, 0o755);
  return binPath;
}

function minimalReport(overrides: Partial<ApiDiffReport> = {}): ApiDiffReport {
  return {
    package: "some-pkg",
    range: "1.1.0",
    usedSymbols: [],
    hasDynamicUsage: false,
    minimumCompatibleVersion: "1.1.0",
    recommendedVersion: "1.1.0",
    versions: [
      {
        version: "1.1.0",
        apiCompatible: true,
        missingSymbols: [],
        unresolvedSymbols: [],
        exportCount: 1,
        typesSource: "bundled",
      },
    ],
    ...overrides,
  };
}

test("runApiDiff: parses a valid JSON report on exit 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-fakebin-"));
  try {
    const report = minimalReport();
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stderr.write("progress line\\n");\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify(report),
      )});\nprocess.exit(0);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-app-"));
    try {
      const result = await runApiDiff({
        appDir,
        packageName: "some-pkg",
        toVersion: "1.1.0",
        binPathOverride: binPath,
      });
      assert.equal(result.exitCode, 0);
      assert.deepEqual(result.report, report);
      assert.match(result.stderr, /progress line/);
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runApiDiff: invalid JSON on stdout is a hard error, not a silent fallback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-fakebin-"));
  try {
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stdout.write("not json at all");\nprocess.exit(1);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-app-"));
    try {
      await assert.rejects(
        () =>
          runApiDiff({
            appDir,
            packageName: "some-pkg",
            toVersion: "1.1.0",
            binPathOverride: binPath,
          }),
        /did not produce valid JSON/,
      );
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runApiDiff: packdev's own error-shaped JSON (valid JSON, no versions[]) is a hard error", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-fakebin-"));
  try {
    const errorShape = { command: "api-diff", package: "some-pkg", success: false, error: "Error: Invalid range: ^1.1.0" };
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(JSON.stringify(errorShape))});\nprocess.exit(1);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-app-"));
    try {
      await assert.rejects(
        () =>
          runApiDiff({
            appDir,
            packageName: "some-pkg",
            toVersion: "^1.1.0",
            binPathOverride: binPath,
          }),
        /did not return an ApiDiffReport.*Invalid range/s,
      );
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runApiDiff: passes toVersion as an exact-match --range", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-fakebin-"));
  try {
    const report = minimalReport();
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stderr.write(JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify(report),
      )});\nprocess.exit(0);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-app-"));
    try {
      const result = await runApiDiff({
        appDir,
        packageName: "some-pkg",
        toVersion: "1.1.0",
        binPathOverride: binPath,
      });
      const argv = JSON.parse(result.stderr) as string[];
      assert.deepEqual(argv, ["api-diff", "some-pkg", "--range", "1.1.0", "--app", ".", "--json"]);
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "runApiDiff: end-to-end against the real installed packdev CLI — confident negative on a genuinely missing named export",
  { timeout: 60_000 },
  async () => {
    // is-odd's ONLY export, at every published 3.x version, is a single
    // default function — it has never had a named "isOdd" export. A
    // fixture that destructures { isOdd } from it is therefore a
    // deterministic, real confident-negative case: apiCompatible: false,
    // hasDynamicUsage: false, missingSymbols: ["isOdd"], reproducible at
    // any 3.x version — not staged or dependent on packdev-internal
    // heuristics the way a duplicate-copy scenario would be.
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-e2e-"));
    try {
      await mkdir(path.join(appDir, "src"), { recursive: true });
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          { name: "apidiff-e2e-fixture", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(appDir, "src", "index.js"),
        'const { isOdd } = require("is-odd");\nisOdd(3);\n',
      );

      const result = await runApiDiff({
        appDir,
        packageName: "is-odd",
        toVersion: "3.0.1",
      });

      assert.equal(result.report.hasDynamicUsage, false);
      assert.ok(result.report.usedSymbols.includes("isOdd"));
      const candidate = result.report.versions.find((v) => v.version === "3.0.1");
      assert.ok(candidate, "3.0.1 should be in the report's versions");
      assert.equal(candidate!.apiCompatible, false);
      assert.deepEqual(candidate!.missingSymbols, ["isOdd"]);
      assert.deepEqual(candidate!.unresolvedSymbols, []);
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);

test(
  "runApiDiff: end-to-end — dynamic (bare require) usage never claims confident compatibility either way",
  { timeout: 60_000 },
  async () => {
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-apidiff-e2e-dyn-"));
    try {
      await mkdir(path.join(appDir, "src"), { recursive: true });
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          { name: "apidiff-e2e-dyn-fixture", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(appDir, "src", "index.js"),
        'const isOdd = require("is-odd");\nisOdd(3);\n',
      );

      const result = await runApiDiff({
        appDir,
        packageName: "is-odd",
        toVersion: "3.0.1",
      });

      assert.equal(result.report.hasDynamicUsage, true);
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);
