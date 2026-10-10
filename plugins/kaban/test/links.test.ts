import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LINK_MIGRATIONS, LinkStore, type TaskLink } from "../src/links.js";

function makeLink(threadId: string, overrides: Partial<TaskLink> = {}): TaskLink {
  return {
    threadId,
    projectId: "proj_1",
    taskId: "01TASKA",
    number: 1,
    title: "Task A",
    linkedAt: 1_000,
    ...overrides,
  };
}

describe("LinkStore", () => {
  let db: Database.Database;
  let store: LinkStore;

  beforeEach(() => {
    db = new Database(":memory:");
    for (const statement of LINK_MIGRATIONS) db.exec(statement);
    store = new LinkStore(db);
  });

  afterEach(() => db.close());

  it("keeps every thread when many link the same task concurrently", async () => {
    const threadIds = Array.from({ length: 25 }, (_, index) => `thr_${index}`);
    // Fire all links in the same tick, interleaved with microtask boundaries,
    // the way concurrent RPC handlers would.
    await Promise.all(
      threadIds.map(async (threadId, index) => {
        await Promise.resolve();
        store.link(makeLink(threadId, { linkedAt: 1_000 + index }));
      }),
    );
    expect(store.threadsForTask("proj_1", "01TASKA")).toEqual(threadIds);
    for (const threadId of threadIds) expect(store.forThread(threadId)?.taskId).toBe("01TASKA");
  });

  it("keeps the index consistent under concurrent link and unlink", async () => {
    for (let index = 0; index < 10; index += 1) store.link(makeLink(`thr_${index}`, { linkedAt: index }));
    await Promise.all(
      Array.from({ length: 10 }, async (_, index) => {
        await Promise.resolve();
        if (index % 2 === 0) store.unlink(`thr_${index}`);
        else store.link(makeLink(`thr_new_${index}`, { linkedAt: 100 + index }));
      }),
    );
    const linked = store.threadsForTask("proj_1", "01TASKA");
    expect(linked).toEqual(["thr_1", "thr_3", "thr_5", "thr_7", "thr_9", "thr_new_1", "thr_new_3", "thr_new_5", "thr_new_7", "thr_new_9"]);
    for (const threadId of linked) expect(store.forThread(threadId)).not.toBeNull();
    expect(store.forThread("thr_0")).toBeNull();
  });

  it("moves a thread to its new task and reports the previous link", () => {
    store.link(makeLink("thr_1"));
    const previous = store.link(makeLink("thr_1", { taskId: "01TASKB", number: 2, title: "Task B", linkedAt: 2_000 }));
    expect(previous?.taskId).toBe("01TASKA");
    expect(store.threadsForTask("proj_1", "01TASKA")).toEqual([]);
    expect(store.threadsForTask("proj_1", "01TASKB")).toEqual(["thr_1"]);
  });

  it("groups links by task within a project only", () => {
    store.link(makeLink("thr_1"));
    store.link(makeLink("thr_2", { taskId: "01TASKB" }));
    store.link(makeLink("thr_3", { projectId: "proj_2" }));
    expect(Object.fromEntries(store.forProject("proj_1"))).toEqual({
      "01TASKA": ["thr_1"],
      "01TASKB": ["thr_2"],
    });
  });

  it("unlink returns the removed link once", () => {
    store.link(makeLink("thr_1"));
    expect(store.unlink("thr_1")?.threadId).toBe("thr_1");
    expect(store.unlink("thr_1")).toBeNull();
  });
});

describe("LinkStore across connections", () => {
  it("loses no links when two connections to one database link the same task", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kaban-links-"));
    const file = path.join(dir, "data.db");
    const first = new Database(file);
    first.pragma("journal_mode = WAL");
    first.pragma("busy_timeout = 5000");
    for (const statement of LINK_MIGRATIONS) first.exec(statement);
    const second = new Database(file);
    second.pragma("busy_timeout = 5000");
    const stores = [new LinkStore(first), new LinkStore(second)];
    try {
      await Promise.all(
        Array.from({ length: 40 }, async (_, index) => {
          await Promise.resolve();
          stores[index % 2]?.link(makeLink(`thr_${index}`, { linkedAt: index }));
        }),
      );
      const expected = Array.from({ length: 40 }, (_, index) => `thr_${index}`);
      expect(stores[0]?.threadsForTask("proj_1", "01TASKA")).toEqual(expected);
      expect(stores[1]?.threadsForTask("proj_1", "01TASKA")).toEqual(expected);
    } finally {
      first.close();
      second.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
