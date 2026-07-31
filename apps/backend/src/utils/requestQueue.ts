/**
 * Serializes async work so at most one job runs at a time, with a minimum
 * interval between consecutive job starts.
 */
export function createRequestQueue(minIntervalMs: number) {
  let tail: Promise<void> = Promise.resolve();
  let lastStartedAt = 0;

  return function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(async () => {
      const waitMs = Math.max(0, lastStartedAt + minIntervalMs - Date.now());
      if (waitMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      }
      lastStartedAt = Date.now();
      return fn();
    });

    // Keep the chain alive after failures so later jobs still run.
    tail = run.then(
      () => undefined,
      () => undefined
    );

    return run;
  };
}
