const { test } = require("node:test");
const assert = require("node:assert/strict");
const isOdd = require("is-odd");

test("isOdd correctly classifies odd and even numbers", () => {
  assert.equal(isOdd(1), true);
  assert.equal(isOdd(2), false);
  assert.equal(isOdd(3), true);
  assert.equal(isOdd(4), false);
});
