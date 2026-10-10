// Per-key serial execution with cancellation.
//
// The kaban CLI runs `PRAGMA integrity_check` on every open without a busy
// timeout, so two kaban processes opening one board at once can misread
// SQLITE_BUSY as corruption and start "recovery" (a WAL checkpoint, then a
// dump/restore that renames board.db). The plugin therefore never runs two
// kaban commands against the same board concurrently.
//
// A task whose caller aborts while it waits is rejected at once and never
// started, so a disconnected `bb kaban move` cannot change the board later.
// Once started, cancellation is the task's job (it receives the signal).
export interface KeyedQueue {
  run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  /** Keys with queued or running work (for tests/diagnostics). */
  size(): number;
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>();
  return {
    run<T>(key: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
      if (signal?.aborted) return Promise.reject(abortError(signal));
      let resolveResult!: (value: T) => void;
      let rejectResult!: (reason: unknown) => void;
      const result = new Promise<T>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      const onAbort = () => {
        if (signal !== undefined) rejectResult(abortError(signal));
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const previous = tails.get(key) ?? Promise.resolve();
      // The tail never rejects and settles only after this task finished (or
      // was skipped), so the next task cannot overlap with it.
      const tail = previous.then(async () => {
        signal?.removeEventListener("abort", onAbort);
        if (signal?.aborted) return; // already rejected; never start it
        try {
          resolveResult(await task());
        } catch (error) {
          rejectResult(error);
        }
      });
      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });
      return result;
    },
    size: () => tails.size,
  };
}
