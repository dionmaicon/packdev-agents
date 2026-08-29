import { test } from "node:test";
import assert from "node:assert/strict";

import { interpret, isAutoMergeEligible } from "../../src/core/interpret.ts";
import type {
  CompatReport,
  CompatVersionResult,
} from "../../src/core/packdevTypes.ts";
import { PACKDEV_EXIT_CODE } from "../../src/core/packdevTypes.ts";

function version(
  overrides: Partial<CompatVersionResult> & { version: string },
): CompatVersionResult {
  return {
    status: "PASSED",
    exitCode: 0,
    durationMs: 1000,
    lockfileHash: null,
    lockfileSnapshotPath: null,
    ...overrides,
  };
}

function report(overrides: Partial<CompatReport> = {}): CompatReport {
  const control = version({ version: "1.0.0" });
  const candidate = version({ version: "1.1.0" });
  return {
    package: "some-pkg",
    minimumCompatibleVersion: null,
    recommendedVersion: null,
    nonMonotonic: false,
    versions: [control, candidate],
    snapshotDir: "/tmp/snapshots",
    concurrency: 1,
    testCommandCaveat: null,
    testCommandCaveats: [],
    control,
    controlFailed: false,
    sandboxMode: "hermetic",
    packageManager: "npm",
    seededLockfile: false,
    lockfileSeedNote: null,
    fanOutConsumers: [],
    ...overrides,
  };
}

test("interpret: control null -> NO_CONTROL, never a PASSED verdict", () => {
  const r = report({ control: null, controlFailed: false });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  assert.equal(verdict.kind, "NO_CONTROL");
  assert.equal(isAutoMergeEligible(verdict), false);
});

test("interpret: controlFailed -> HARNESS_BROKEN, outranks a passing candidate", () => {
  const control = version({ version: "1.0.0", status: "FAILED" });
  const candidate = version({ version: "1.1.0", status: "PASSED" });
  const r = report({
    versions: [control, candidate],
    control,
    controlFailed: true,
  });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  assert.equal(verdict.kind, "HARNESS_BROKEN");
});

test("interpret: candidate INSTALL_FAILED -> INSTALL_FAILED, not INCOMPATIBLE", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "INSTALL_FAILED" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);
  assert.equal(verdict.kind, "INSTALL_FAILED");
  if (verdict.kind === "INSTALL_FAILED") {
    assert.equal(verdict.failedVersions.length, 1);
    assert.equal(verdict.failedVersions[0]!.version, "1.1.0");
  }
});

test("interpret: exit code 6 -> NOTHING_TESTED, not a pass", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "SKIPPED" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.NOTHING_TESTED);
  assert.equal(verdict.kind, "NOTHING_TESTED");
  assert.equal(isAutoMergeEligible(verdict), false);
});

test("interpret: all candidates SKIPPED -> NOTHING_TESTED even without exit 6", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "SKIPPED" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  assert.equal(verdict.kind, "NOTHING_TESTED");
});

test("interpret: no candidates at all -> NOTHING_TESTED", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const r = report({ versions: [control], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  assert.equal(verdict.kind, "NOTHING_TESTED");
});

test("interpret: candidate FAILED -> INCOMPATIBLE", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "FAILED" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);
  assert.equal(verdict.kind, "INCOMPATIBLE");
  if (verdict.kind === "INCOMPATIBLE") {
    assert.equal(verdict.failedVersions[0]!.version, "1.1.0");
  }
  assert.equal(isAutoMergeEligible(verdict), false);
});

test("interpret: candidate PASSED with testCommandCaveats -> PASSED_WEAK", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "PASSED" });
  const r = report({
    versions: [control, candidate],
    control,
    testCommandCaveats: [
      {
        code: "TRANSPILE_ONLY",
        severity: "warning",
        message: "ts-jest isolatedModules never reads the dependency's types",
      },
    ],
  });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  assert.equal(verdict.kind, "PASSED_WEAK");
  assert.equal(isAutoMergeEligible(verdict), false);
  if (verdict.kind === "PASSED_WEAK") {
    assert.equal(verdict.caveats.length, 1);
  }
});

test("interpret: candidate PASSED with no caveats -> PASSED, auto-merge eligible", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "PASSED" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  assert.equal(verdict.kind, "PASSED");
  assert.equal(isAutoMergeEligible(verdict), true);
});

test("interpret: precedence — HARNESS_BROKEN outranks candidate INSTALL_FAILED", () => {
  const control = version({ version: "1.0.0", status: "FAILED" });
  const candidate = version({ version: "1.1.0", status: "INSTALL_FAILED" });
  const r = report({
    versions: [control, candidate],
    control,
    controlFailed: true,
  });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.GENERIC_ERROR);
  assert.equal(verdict.kind, "HARNESS_BROKEN");
});

test("interpret: precedence — INSTALL_FAILED outranks NOTHING_TESTED/INCOMPATIBLE mix", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const a = version({ version: "1.1.0", status: "INSTALL_FAILED" });
  const b = version({ version: "1.2.0", status: "SKIPPED" });
  const r = report({ versions: [control, a, b], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.GENERIC_ERROR);
  assert.equal(verdict.kind, "INSTALL_FAILED");
});
