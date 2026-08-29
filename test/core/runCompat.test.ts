import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runCompat } from "../../src/core/runCompat.ts";
import type { CompatReport } from "../../src/core/packdevTypes.ts";

/**
 * Writes a fake "packdev" entry script that mimics the real CLI's contract
 * (JSON report on stdout, meaningful nonzero exit codes) without spawning
 * a real sandboxed install — keeps these tests fast and network-free. The
 * real CLI wiring is covered separately by an end-to-end test against the
 * actually-installed packdev package.
 */
async function writeFakeBin(
  dir: string,
  script: string,
): Promise<string> {
  const binPath = path.join(dir, "fake-packdev.mjs");
  await writeFile(binPath, script);
  await chmod(binPath, 0o755);
  return binPath;
}

function minimalReport(overrides: Partial<CompatReport> = {}): CompatReport {
  return {
    package: "some-pkg",
    minimumCompatibleVersion: "1.1.0",
    recommendedVersion: "1.1.0",
    nonMonotonic: false,
    versions: [
      {
        version: "1.0.0",
        status: "PASSED",
        exitCode: 0,
        durationMs: 100,
        lockfileHash: null,
        lockfileSnapshotPath: null,
      },
      {
        version: "1.1.0",
        status: "PASSED",
        exitCode: 0,
        durationMs: 120,
        lockfileHash: null,
        lockfileSnapshotPath: null,
      },
    ],
    snapshotDir: "/tmp/snapshots",
    concurrency: 1,
    testCommandCaveat: null,
    testCommandCaveats: [],
    control: {
      version: "1.0.0",
      status: "PASSED",
      exitCode: 0,
      durationMs: 100,
      lockfileHash: null,
      lockfileSnapshotPath: null,
    },
    controlFailed: false,
    sandboxMode: "hermetic",
    packageManager: "npm",
    seededLockfile: false,
    lockfileSeedNote: null,
    fanOutConsumers: [],
    ...overrides,
  };
}

test("runCompat: parses a valid JSON report on exit 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-fakebin-"));
  try {
    const report = minimalReport();
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stderr.write("progress line\\n");\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify(report),
      )});\nprocess.exit(0);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-app-"));
    try {
      const result = await runCompat({
        appDir,
        packageName: "some-pkg",
        versions: ["1.1.0"],
        testCommand: "true",
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

test("runCompat: nonzero exit (e.g. COMPAT_FAILED=7) still resolves with the parsed report", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-fakebin-"));
  try {
    const report = minimalReport({
      versions: [
        {
          version: "1.0.0",
          status: "PASSED",
          exitCode: 0,
          durationMs: 100,
          lockfileHash: null,
          lockfileSnapshotPath: null,
        },
        {
          version: "1.1.0",
          status: "FAILED",
          exitCode: 1,
          durationMs: 120,
          lockfileHash: null,
          lockfileSnapshotPath: null,
        },
      ],
      minimumCompatibleVersion: null,
      recommendedVersion: null,
    });
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(
        JSON.stringify(report),
      )});\nprocess.exit(7);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-app-"));
    try {
      const result = await runCompat({
        appDir,
        packageName: "some-pkg",
        versions: ["1.1.0"],
        testCommand: "true",
        binPathOverride: binPath,
      });
      assert.equal(result.exitCode, 7);
      assert.equal(result.report.versions[1]!.status, "FAILED");
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runCompat: invalid JSON on stdout is a hard error, not a silent fallback", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-fakebin-"));
  try {
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stdout.write("not json at all");\nprocess.exit(1);\n`,
    );
    const appDir = await mkdtemp(path.join(tmpdir(), "packdev-agents-app-"));
    try {
      await assert.rejects(
        () =>
          runCompat({
            appDir,
            packageName: "some-pkg",
            versions: ["1.1.0"],
            testCommand: "true",
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

test(
  "runCompat: end-to-end against the real installed packdev CLI",
  { timeout: 120_000 },
  async () => {
    const appDir = await mkdtemp(
      path.join(tmpdir(), "packdev-agents-e2e-app-"),
    );
    try {
      await mkdir(path.join(appDir, "src"), { recursive: true });
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          {
            name: "e2e-fixture-app",
            version: "1.0.0",
            dependencies: { "is-odd": "3.0.0" },
          },
          null,
          2,
        ),
      );

      // Install the control (pre-bump) version so packdev's control
      // resolution (node_modules-based, see docs/architecture.md) has
      // something real to find.
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      await execFileAsync("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: appDir,
      });

      const result = await runCompat({
        appDir,
        packageName: "is-odd",
        versions: ["3.0.1"],
        testCommand:
          'node -e "if (require(\'is-odd\')(4) !== false) process.exit(1)"',
      });

      assert.equal(result.report.package, "is-odd");
      assert.ok(result.report.control, "control should have resolved from node_modules");
      assert.equal(result.report.control!.version, "3.0.0");
      const candidate = result.report.versions.find(
        (v) => v.version === "3.0.1",
      );
      assert.ok(candidate, "3.0.1 should be in the report's versions");
      assert.equal(candidate!.status, "PASSED");
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);
