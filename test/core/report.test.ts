import { test } from "node:test";
import assert from "node:assert/strict";

import { render } from "../../src/core/report.ts";
import { interpret } from "../../src/core/interpret.ts";
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

test("render: PASSED shows package/version summary, provenance, and auto-merge line", () => {
  const r = report();
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  const md = render(verdict);

  assert.match(md, /some-pkg/);
  assert.match(md, /`1\.0\.0`/);
  assert.match(md, /`1\.1\.0`/);
  assert.match(md, /Passed/);
  assert.match(md, /Sandbox: `hermetic`/);
  assert.match(md, /Package manager: `npm`/);
  assert.match(md, /Auto-merge eligible\./);
});

test("render: NO_CONTROL never claims a verdict about the bump, never says auto-merge eligible", () => {
  const r = report({ control: null, controlFailed: false });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  const md = render(verdict);

  assert.match(md, /No control version could be resolved/);
  assert.match(md, /No verdict on the bump itself can be trusted/);
  assert.match(md, /requires human review/);
});

test("render: HARNESS_BROKEN includes the control's output and never blames the bump", () => {
  const control = version({
    version: "1.0.0",
    status: "FAILED",
    output: "TypeError: cannot read property of undefined",
  });
  const candidate = version({ version: "1.1.0", status: "PASSED" });
  const r = report({ versions: [control, candidate], control, controlFailed: true });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  const md = render(verdict);

  assert.match(md, /test harness itself is broken/);
  assert.match(md, /says nothing about whether the bump is safe/);
  assert.match(md, /TypeError: cannot read property of undefined/);
});

test("render: INSTALL_FAILED names the failed version and includes its output, not framed as incompatibility", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({
    version: "1.1.0",
    status: "INSTALL_FAILED",
    output: "npm ERR! 404 Not Found",
  });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);
  const md = render(verdict);

  assert.match(md, /`1\.1\.0`/);
  assert.match(md, /not evidence the candidate version is incompatible/);
  assert.match(md, /npm ERR! 404 Not Found/);
});

test("render: NOTHING_TESTED explicitly says it is not a pass", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "SKIPPED" });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.NOTHING_TESTED);
  const md = render(verdict);

  assert.match(md, /Nothing was determined by this run/);
  assert.match(md, /requires human review/);
});

test("render: INCOMPATIBLE names the failed version and includes its output", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({
    version: "1.1.0",
    status: "FAILED",
    output: "1 failing\n  1) breaks on new API",
  });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);
  const md = render(verdict);

  assert.match(md, /incompatible with this app/);
  assert.match(md, /breaks on new API/);
});

test("render: PASSED_WEAK surfaces the caveat verbatim and marks it not auto-merge eligible", () => {
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
  const md = render(verdict);

  assert.match(md, /weak evidence, not a clean pass/);
  assert.match(md, /TRANSPILE_ONLY/);
  assert.match(md, /ts-jest isolatedModules never reads the dependency's types/);
  assert.match(md, /requires human review/);
});

test("render: esmMismatch and dupesRegression are surfaced even on a PASSED verdict", () => {
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({
    version: "1.1.0",
    status: "PASSED",
    esmMismatch: "candidate is ESM-only but the test harness is CJS-blind jest",
    dupesRegression: [{ package: "lodash", controlCopies: 1, candidateCopies: 2 }],
  });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.SUCCESS);
  const md = render(verdict);

  assert.equal(verdict.kind, "PASSED");
  assert.match(md, /ESM-only but the test harness is CJS-blind jest/);
  assert.match(md, /`lodash` 1 → 2/);
});

test("render: long output is truncated with a marker, not silently dropped", () => {
  const bigOutput = "x".repeat(5000);
  const control = version({ version: "1.0.0", status: "PASSED" });
  const candidate = version({ version: "1.1.0", status: "FAILED", output: bigOutput });
  const r = report({ versions: [control, candidate], control });
  const verdict = interpret(r, PACKDEV_EXIT_CODE.COMPAT_FAILED);
  const md = render(verdict);

  assert.match(md, /truncated, 1000 more characters/);
  assert.ok(!md.includes(bigOutput), "full untruncated output must not appear");
});
