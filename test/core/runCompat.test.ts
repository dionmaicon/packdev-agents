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

test("runCompat: forwards extraArgs verbatim to the spawned packdev process", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "packdev-agents-fakebin-"));
  try {
    const report = minimalReport();
    // Echoes argv to stderr so the test can assert on exactly what reached
    // the CLI, then answers with a normal report — this is a structural
    // pass-through check (extraArgs -> spawned argv), not a claim about
    // what packdev's own dupes heuristics detect in any given tree; that's
    // covered separately by the e2e smoke test below.
    const binPath = await writeFakeBin(
      dir,
      `#!/usr/bin/env node\nprocess.stderr.write(JSON.stringify(process.argv.slice(2)));\nprocess.stdout.write(${JSON.stringify(
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
        extraArgs: ["--check-dupes", "--seed-lockfile"],
      });
      const argv = JSON.parse(result.stderr) as string[];
      assert.ok(argv.includes("--check-dupes"));
      assert.ok(argv.includes("--seed-lockfile"));
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "runCompat: --check-dupes + --seed-lockfile run cleanly end-to-end against the real CLI",
  { timeout: 120_000 },
  async () => {
    // A real nested-fork duplicate does exist in this fixture's resolved
    // tree (verified manually: node_modules/is-odd@3.0.1 at the top plus a
    // second, distinct is-odd@3.0.0 nested under the file: dependency,
    // visible in packdev's own lockfile snapshot) — but whether packdev's
    // dupes scanner surfaces it as dupesRegression depends on its own
    // internal graph-walk heuristics (e.g. whether it follows node_modules
    // under a symlinked local "file:" package), which isn't something this
    // repo controls or should assert on. This test only proves the flags
    // are safe to always pass: the real CLI accepts them, still resolves a
    // real control, and still runs the real test command to completion.
    const appDir = await mkdtemp(
      path.join(tmpdir(), "packdev-agents-dupes-app-"),
    );
    try {
      await mkdir(path.join(appDir, "vendor", "wrapper-lib"), { recursive: true });
      await writeFile(
        path.join(appDir, "vendor", "wrapper-lib", "package.json"),
        JSON.stringify(
          { name: "wrapper-lib", version: "1.0.0", dependencies: { "is-odd": "3.0.0" } },
          null,
          2,
        ),
      );
      await writeFile(
        path.join(appDir, "package.json"),
        JSON.stringify(
          {
            name: "dupes-fixture-app",
            version: "1.0.0",
            dependencies: { "is-odd": "3.0.0", "wrapper-lib": "file:./vendor/wrapper-lib" },
          },
          null,
          2,
        ),
      );

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
        testCommand: 'node -e "require(\'is-odd\')(4)"',
        extraArgs: ["--check-dupes", "--seed-lockfile"],
      });

      assert.equal(result.report.seededLockfile, true);
      assert.ok(result.report.control, "control should have resolved from node_modules");
      const candidate = result.report.versions.find((v) => v.version === "3.0.1");
      assert.ok(candidate, "3.0.1 should be in the report's versions");
      assert.equal(candidate!.status, "PASSED");
    } finally {
      await rm(appDir, { recursive: true, force: true });
    }
  },
);
