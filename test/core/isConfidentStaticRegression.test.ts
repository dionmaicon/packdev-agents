import { test } from "node:test";
import assert from "node:assert/strict";

import { isConfidentStaticRegression } from "../../src/core/pipeline.ts";

// Real bug, found live: the static pre-filter used to check the candidate
// version's api-diff result alone. is-odd never exported a named "isOdd"
// at ANY version, so a real test PR bumping 3.0.0 -> 3.0.1 was reported
// "the bump is incompatible with this app" — false, since the app was
// equally broken before the bump. isConfidentStaticRegression is the
// extracted fix: only a symbol missing from the candidate AND NOT already
// missing from the control counts as a genuine regression.

test("isConfidentStaticRegression: candidate missing, control genuinely has it -> true (a real regression)", () => {
  assert.equal(
    isConfidentStaticRegression({ apiCompatible: false }, false, { apiCompatible: true }),
    true,
  );
});

test("isConfidentStaticRegression: candidate missing, control ALSO missing -> false (pre-existing, not a regression — the exact real bug)", () => {
  assert.equal(
    isConfidentStaticRegression({ apiCompatible: false }, false, { apiCompatible: false }),
    false,
  );
});

test("isConfidentStaticRegression: candidate missing, control unverifiable (null) -> true — a null control can't excuse a confident candidate failure", () => {
  assert.equal(
    isConfidentStaticRegression({ apiCompatible: false }, false, { apiCompatible: null }),
    true,
  );
});

test("isConfidentStaticRegression: candidate missing, no control entry found at all -> true", () => {
  assert.equal(isConfidentStaticRegression({ apiCompatible: false }, false, undefined), true);
});

test("isConfidentStaticRegression: dynamic usage always disqualifies, regardless of control", () => {
  assert.equal(
    isConfidentStaticRegression({ apiCompatible: false }, true, { apiCompatible: true }),
    false,
  );
});

test("isConfidentStaticRegression: candidate compatible -> always false", () => {
  assert.equal(
    isConfidentStaticRegression({ apiCompatible: true }, false, { apiCompatible: false }),
    false,
  );
});

test("isConfidentStaticRegression: candidate unverifiable (null) -> always false, never a confident negative", () => {
  assert.equal(
    isConfidentStaticRegression({ apiCompatible: null }, false, { apiCompatible: true }),
    false,
  );
});

test("isConfidentStaticRegression: no candidate entry found at all -> false", () => {
  assert.equal(isConfidentStaticRegression(undefined, false, { apiCompatible: true }), false);
});
