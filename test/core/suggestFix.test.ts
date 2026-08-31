import { test } from "node:test";
import assert from "node:assert/strict";

import { parsePeerConflicts, renderSuggestedFix } from "../../src/core/suggestFix.ts";

// Real npm ERESOLVE output, captured verbatim from a genuine
// packdev-demo-nestjs Dependabot PR (dionmaicon/packdev-demo-nestjs#31,
// 2026-08-31) — not hand-written, to keep the parser honest about npm's
// actual format instead of an idealized one.
const REAL_NESTJS_ERESOLVE = `npm error code ERESOLVE
npm error ERESOLVE unable to resolve dependency tree
npm error
npm error While resolving: @packdev-demo/notifier@1.0.0
npm error Found: @nestjs/common@11.0.21
npm error node_modules/@nestjs/common
npm error   @nestjs/common@"11.0.21" from the root project
npm error
npm error Could not resolve dependency:
npm error peer @nestjs/common@"^12.0.0" from @nestjs/core@12.0.1
npm error node_modules/@nestjs/core
npm error   @nestjs/core@"12.0.1" from the root project
npm error
npm error Fix the upstream dependency conflict, or retry this command with --force or --legacy-peer-deps to accept an incorrect (and potentially broken) dependency resolution.
npm error
npm error
npm error For a full report see:
npm error /home/runner/.npm/_logs/2026-08-31T12_29_51_934Z-eresolve-report.txt
npm error A complete log of this run can be found in: /home/runner/.npm/_logs/2026-08-31T12_29_51_934Z-debug-0.log
`;

test("parsePeerConflicts: parses a real npm ERESOLVE peer conflict verbatim", () => {
  const conflicts = parsePeerConflicts(REAL_NESTJS_ERESOLVE);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0], {
    peerPackage: "@nestjs/common",
    peerRange: "^12.0.0",
    requiredBy: "@nestjs/core",
    requiredByVersion: "12.0.1",
    currentPeerVersion: "11.0.21",
  });
});

test("parsePeerConflicts: no ERESOLVE shape present -> empty, never throws", () => {
  assert.deepEqual(parsePeerConflicts(""), []);
  assert.deepEqual(parsePeerConflicts("npm error some unrelated failure\n"), []);
  assert.deepEqual(parsePeerConflicts("Error: connection refused"), []);
});

test("parsePeerConflicts: duplicate peer/requiredBy pairs are deduped", () => {
  const doubled = REAL_NESTJS_ERESOLVE + REAL_NESTJS_ERESOLVE;
  assert.equal(parsePeerConflicts(doubled).length, 1);
});

test("parsePeerConflicts: a peer line with no matching 'Found:' line still parses, currentPeerVersion is null", () => {
  const noFound = `npm error code ERESOLVE
npm error Could not resolve dependency:
npm error peer eslint@">=8.57.1" from eslint-plugin-n@18.3.0
`;
  const conflicts = parsePeerConflicts(noFound);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0]!.currentPeerVersion, null);
  assert.equal(conflicts[0]!.peerPackage, "eslint");
  assert.equal(conflicts[0]!.peerRange, ">=8.57.1");
});

test("renderSuggestedFix: no conflicts -> null, no empty section rendered", () => {
  assert.equal(renderSuggestedFix("@nestjs/core", "12.0.1", []), null);
});

test("renderSuggestedFix: real conflict renders a copy-paste npm install command with the peer range, not a guessed version", () => {
  const conflicts = parsePeerConflicts(REAL_NESTJS_ERESOLVE);
  const rendered = renderSuggestedFix("@nestjs/core", "12.0.1", conflicts);
  assert.ok(rendered);
  assert.match(rendered!, /npm install @nestjs\/core@12\.0\.1 @nestjs\/common@"\^12\.0\.0"/);
  assert.match(rendered!, /currently `11\.0\.21`/);
  assert.match(rendered!, /required by `@nestjs\/core@12\.0\.1`/);
});

test("renderSuggestedFix: two distinct peer packages both appear in the command, each range preserved exactly", () => {
  const conflicts = parsePeerConflicts(`npm error peer eslint@">=8.57.1" from eslint-plugin-n@18.3.0
npm error peer typescript@">=5.0.0" from eslint-plugin-n@18.3.0
`);
  const rendered = renderSuggestedFix("eslint-plugin-n", "18.3.0", conflicts);
  assert.ok(rendered);
  assert.match(rendered!, /npm install eslint-plugin-n@18\.3\.0 eslint@">=8\.57\.1" typescript@">=5\.0\.0"/);
});
