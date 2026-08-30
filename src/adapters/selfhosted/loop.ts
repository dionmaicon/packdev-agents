export interface PollLoopOptions {
  runOnce: () => Promise<unknown>;
  sleep: (ms: number) => Promise<void>;
  intervalMs: number;
  /** Defaults to logging via console.error — a throwing runOnce must never kill the loop. */
  onError?: ((error: unknown) => void) | undefined;
}

export interface PollLoop {
  /** Runs cycles until stop() is called. Resolves once the loop has actually exited. */
  start: () => Promise<void>;
  /**
   * Requests the loop stop. Takes effect at the next check: immediately if
   * called before start(), or after the in-flight runOnce/sleep settles —
   * this never interrupts a cycle already in progress.
   */
  stop: () => void;
}

/**
 * Extracted out of main.ts so the interval/signal/error-swallowing behavior
 * (previously only exercised by hand against a real GitHub repo) can be
 * unit tested with fake runOnce/sleep — no real network calls, no real
 * timers, no waiting out a real POLL_INTERVAL_SECONDS.
 */
export function createPollLoop(options: PollLoopOptions): PollLoop {
  let stopped = false;
  const onError = options.onError ?? ((error: unknown) => console.error("Poll failed:", error));

  return {
    stop(): void {
      stopped = true;
    },
    async start(): Promise<void> {
      while (!stopped) {
        try {
          await options.runOnce();
        } catch (error) {
          onError(error);
        }
        if (stopped) break;
        await options.sleep(options.intervalMs);
      }
    },
  };
}
