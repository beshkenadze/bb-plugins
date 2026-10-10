import { describe, expect, it } from "vitest";
import { createKeyedQueue } from "../src/serial.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe("createKeyedQueue", () => {
  it("never runs two tasks for one key at the same time, and keeps order", async () => {
    const queue = createKeyedQueue();
    let running = 0;
    let maxRunning = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        queue.run("host:/repo", async () => {
          running += 1;
          maxRunning = Math.max(maxRunning, running);
          await tick();
          order.push(index);
          running -= 1;
        }),
      ),
    );
    expect(maxRunning).toBe(1);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    await tick(); // the finished tail is dropped on a later microtask
    expect(queue.size()).toBe(0);
  });

  it("rejects a waiting task as soon as it is aborted and never starts it", async () => {
    const queue = createKeyedQueue();
    let release!: () => void;
    const busy = queue.run("k", () => new Promise<void>((resolve) => (release = resolve)));
    const controller = new AbortController();
    let started = false;
    const waiting = queue.run(
      "k",
      async () => {
        started = true;
      },
      controller.signal,
    );
    const after = queue.run("k", async () => "after");
    controller.abort(new Error("client disconnected"));
    await expect(waiting).rejects.toThrow("client disconnected");
    release();
    await busy;
    await expect(after).resolves.toBe("after");
    expect(started).toBe(false);
  });

  it("rejects an already-aborted task without queueing it", async () => {
    const queue = createKeyedQueue();
    const controller = new AbortController();
    controller.abort();
    let started = false;
    await expect(
      queue.run(
        "k",
        async () => {
          started = true;
        },
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(started).toBe(false);
    expect(queue.size()).toBe(0);
  });

  it("runs different keys in parallel", async () => {
    const queue = createKeyedQueue();
    let running = 0;
    let maxRunning = 0;
    const task = async () => {
      running += 1;
      maxRunning = Math.max(maxRunning, running);
      await tick();
      running -= 1;
    };
    await Promise.all([queue.run("a", task), queue.run("b", task), queue.run("c", task)]);
    expect(maxRunning).toBe(3);
  });

  it("keeps going after a failure and reports it to its caller only", async () => {
    const queue = createKeyedQueue();
    const failed = queue.run("k", async () => {
      throw new Error("boom");
    });
    const next = queue.run("k", async () => "ok");
    await expect(failed).rejects.toThrow("boom");
    await expect(next).resolves.toBe("ok");
  });
});
