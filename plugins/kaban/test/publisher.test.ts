import { describe, expect, it } from "vitest";
import { createThrottledPublisher, type PublisherClock } from "../src/publisher.js";

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const clock: PublisherClock = {
    now: () => now,
    setTimeout: (callback, ms) => {
      nextId += 1;
      timers.set(nextId, { at: now + ms, callback });
      return nextId;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at > now) continue;
      timers.delete(id);
      timer.callback();
    }
  };
  return { clock, advance, pending: () => timers.size };
}

describe("createThrottledPublisher", () => {
  it("publishes immediately when quiet", () => {
    const { clock } = fakeClock();
    const published: string[] = [];
    createThrottledPublisher((id) => published.push(id), 750, clock).request("p1");
    expect(published).toEqual(["p1"]);
  });

  it("never drops a change that arrives inside the interval: it is delivered on the trailing edge", () => {
    const { clock, advance } = fakeClock();
    const published: Array<[string, number]> = [];
    const publisher = createThrottledPublisher((id) => published.push([id, clock.now()]), 750, clock);
    publisher.request("p1"); // our own write
    advance(100);
    publisher.request("p1"); // an external TUI edit right after
    publisher.request("p1"); // coalesced
    expect(published).toEqual([["p1", 0]]);
    advance(650);
    expect(published).toEqual([
      ["p1", 0],
      ["p1", 750],
    ]);
  });

  it("throttles projects independently", () => {
    const { clock } = fakeClock();
    const published: string[] = [];
    const publisher = createThrottledPublisher((id) => published.push(id), 750, clock);
    publisher.request("p1");
    publisher.request("p2");
    expect(published).toEqual(["p1", "p2"]);
  });

  it("cancels pending publishes on dispose", () => {
    const { clock, advance, pending } = fakeClock();
    const published: string[] = [];
    const publisher = createThrottledPublisher((id) => published.push(id), 750, clock);
    publisher.request("p1");
    publisher.request("p1");
    expect(pending()).toBe(1);
    publisher.dispose();
    advance(1_000);
    expect(published).toEqual(["p1"]);
    expect(pending()).toBe(0);
  });
});
