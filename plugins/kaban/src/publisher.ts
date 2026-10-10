// Coalescing "board changed" notifier.
//
// Every request to notify is honored: the first in a quiet period publishes
// immediately (leading edge) and any further requests inside the interval are
// folded into exactly one trailing publish when it ends. Nothing is dropped,
// so a real change that lands right after our own CLI run still reaches open
// boards; a pathological writer is bounded to one refetch per interval.
export interface ThrottledPublisher {
  request(projectId: string): void;
  dispose(): void;
}

export interface PublisherClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const systemClock: PublisherClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function createThrottledPublisher(
  publishNow: (projectId: string) => void,
  intervalMs: number,
  clock: PublisherClock = systemClock,
): ThrottledPublisher {
  const lastPublishedAt = new Map<string, number>();
  const pending = new Map<string, unknown>();
  let disposed = false;

  const fire = (projectId: string) => {
    pending.delete(projectId);
    if (disposed) return;
    lastPublishedAt.set(projectId, clock.now());
    publishNow(projectId);
  };

  return {
    request(projectId) {
      if (disposed || pending.has(projectId)) return;
      const elapsed = clock.now() - (lastPublishedAt.get(projectId) ?? Number.NEGATIVE_INFINITY);
      if (elapsed >= intervalMs) {
        fire(projectId);
        return;
      }
      pending.set(projectId, clock.setTimeout(() => fire(projectId), intervalMs - elapsed));
    },
    dispose() {
      disposed = true;
      for (const handle of pending.values()) clock.clearTimeout(handle);
      pending.clear();
    },
  };
}
