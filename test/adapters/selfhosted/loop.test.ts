import { test } from "node:test";
import assert from "node:assert/strict";

import { createPollLoop } from "../../../src/adapters/selfhosted/loop.js";

/** Immediate, no real timers — makes the loop's own cycle count the thing under test, not wall-clock time. */
function fakeSleep(calls: number[]): (ms: number) => Promise<void> {
  return async (ms: number) => {
    calls.push(ms);
  };
}

test("createPollLoop: runs cycles until stop() is called, sleeping intervalMs between each", async () => {
  let runs = 0;
  const sleepCalls: number[] = [];
  const loop = createPollLoop({
    runOnce: async () => {
      runs++;
      if (runs === 3) loop.stop();
    },
    sleep: fakeSleep(sleepCalls),
    intervalMs: 1234,
  });

  await loop.start();

  assert.equal(runs, 3);
  // stop() during the 3rd runOnce takes effect before that cycle's sleep —
  // only 2 sleeps for 3 runs.
  assert.deepEqual(sleepCalls, [1234, 1234]);
});

test("createPollLoop: stop() called before start() -> zero cycles run", async () => {
  let runs = 0;
  const loop = createPollLoop({
    runOnce: async () => {
      runs++;
    },
    sleep: fakeSleep([]),
    intervalMs: 1000,
  });

  loop.stop();
  await loop.start();

  assert.equal(runs, 0);
});

test("createPollLoop: a throwing runOnce is reported via onError and does not stop the loop", async () => {
  let runs = 0;
  const errors: unknown[] = [];
  const loop = createPollLoop({
    runOnce: async () => {
      runs++;
      if (runs === 1) throw new Error("transient failure");
      if (runs === 2) loop.stop();
    },
    sleep: fakeSleep([]),
    intervalMs: 100,
    onError: (error) => errors.push(error),
  });

  await loop.start();

  assert.equal(runs, 2);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /transient failure/);
});

test("createPollLoop: with no onError given, a throw is swallowed (not rethrown) so the loop keeps going", async () => {
  let runs = 0;
  const loop = createPollLoop({
    runOnce: async () => {
      runs++;
      if (runs === 1) throw new Error("boom");
      if (runs === 2) loop.stop();
    },
    sleep: fakeSleep([]),
    intervalMs: 100,
  });

  await assert.doesNotReject(loop.start());
  assert.equal(runs, 2);
});

test("createPollLoop: stop() requested while sleeping takes effect on the next cycle check, not mid-sleep", async () => {
  let runs = 0;
  const loop = createPollLoop({
    runOnce: async () => {
      runs++;
    },
    sleep: async () => {
      // Simulate stop() arriving (e.g. a SIGTERM) while a real interval sleep is in flight.
      loop.stop();
    },
    intervalMs: 100,
  });

  await loop.start();

  // First cycle runs, then sleep fires stop() — loop checks !stopped at the
  // top of the next iteration and exits without a second runOnce call.
  assert.equal(runs, 1);
});
