import { describe, expect, it } from "vitest";
import { firstThreadId, matchesSearch, sortProjects } from "./model";
import { project, thread } from "./test/fixtures";

const names = (projects: ReturnType<typeof sortProjects>) => projects.map((item) => item.name);

describe("sortProjects", () => {
  it("orders by name, ignoring case, with natural number order", () => {
    const sorted = sortProjects([
      project("p1", "zeta"), project("p2", "Beta"), project("p3", "alpha"), project("p4", "app 10"), project("p5", "app 9"),
    ]);
    expect(names(sorted)).toEqual(["alpha", "app 9", "app 10", "Beta", "zeta"]);
  });

  it("orders non-Latin names alphabetically too", () => {
    expect(names(sortProjects([project("p1", "Яблоко"), project("p2", "арбуз"), project("p3", "Груша")])))
      .toEqual(["арбуз", "Груша", "Яблоко"]);
  });

  it("keeps projects with equal names in a stable id order and leaves the input untouched", () => {
    const input = [project("b", "Same"), project("a", "same")];
    expect(sortProjects(input).map((item) => item.id)).toEqual(["a", "b"]);
    expect(input.map((item) => item.id)).toEqual(["b", "a"]);
  });
});

describe("firstThreadId", () => {
  it("picks the thread with the most recent attention, not the most recently updated one", () => {
    const threads = [
      thread("touched", { latestAttentionAt: 100, updatedAt: 900 }),
      thread("recent", { latestAttentionAt: 300, updatedAt: 200 }),
      thread("other-project", { projectId: "beta", latestAttentionAt: 999 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("recent");
  });

  it("breaks attention ties by newest creation, then by id", () => {
    expect(firstThreadId([
      thread("older", { latestAttentionAt: 5, createdAt: 1 }),
      thread("newer", { latestAttentionAt: 5, createdAt: 2 }),
    ], "alpha")).toBe("newer");
    expect(firstThreadId([thread("b"), thread("a")], "alpha")).toBe("a");
  });

  it("puts active threads first, newest created first, as bb's sidebar does", () => {
    const threads = [
      thread("idle", { latestAttentionAt: 999 }),
      thread("active-old", { status: "active", createdAt: 100, latestAttentionAt: 900 }),
      thread("active-new", { status: "active", createdAt: 200, latestAttentionAt: 1 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("active-new");
  });

  it("does not rank starting, stopping, or unknown statuses as active", () => {
    const threads = [
      thread("idle", { latestAttentionAt: 300 }),
      thread("starting", { status: "starting", latestAttentionAt: 100 }),
      thread("stopping", { status: "stopping", latestAttentionAt: 100 }),
      thread("future", { status: "something-new" as never, latestAttentionAt: 100 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("idle");
  });

  it("prefers the project's group over pinned threads, which bb lists under Pinned", () => {
    const threads = [
      thread("pinned", { isPinned: true, pinnedAt: 1, latestAttentionAt: 900 }),
      thread("unpinned", { latestAttentionAt: 100 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("unpinned");
  });

  it("falls back to a pinned thread when every thread of the project is pinned", () => {
    const threads = [
      thread("pinned-old", { isPinned: true, pinnedAt: 1, latestAttentionAt: 100 }),
      thread("pinned-new", { isPinned: true, pinnedAt: 2, latestAttentionAt: 200 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("pinned-new");
  });

  it("skips archived, hidden, and nested threads", () => {
    const threads = [
      thread("root", { latestAttentionAt: 1 }),
      thread("archived", { isArchived: true, latestAttentionAt: 5 }),
      thread("hidden", { isHidden: true, latestAttentionAt: 6 }),
      thread("child", { parentThreadId: "root", latestAttentionAt: 7 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("root");
  });

  it("counts a child whose parent is not listed as a top-level thread", () => {
    const threads = [
      thread("root", { latestAttentionAt: 1 }),
      thread("orphan", { parentThreadId: "archived-parent", latestAttentionAt: 2 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("orphan");
  });

  it("counts a visible child of a hidden thread as top-level, as bb's list does", () => {
    const threads = [
      thread("root", { latestAttentionAt: 1 }),
      thread("helper", { isHidden: true, latestAttentionAt: 2 }),
      thread("child", { parentThreadId: "helper", latestAttentionAt: 3 }),
    ];
    expect(firstThreadId(threads, "alpha")).toBe("child");
    expect(firstThreadId(threads.slice(1), "alpha")).toBe("child");
  });

  it("returns null for a project without visible threads", () => {
    expect(firstThreadId([thread("elsewhere", { projectId: "beta" })], "alpha")).toBeNull();
    expect(firstThreadId([thread("gone", { isArchived: true })], "alpha")).toBeNull();
    expect(firstThreadId([], "alpha")).toBeNull();
  });
});

describe("matchesSearch", () => {
  it("matches a case-insensitive substring of the name", () => {
    expect(matchesSearch("bb-Project", "PROJ")).toBe(true);
    expect(matchesSearch("bb-project", "  proj ")).toBe(true);
    expect(matchesSearch("Проекты", "проект")).toBe(true);
    expect(matchesSearch("bb-project", "kaban")).toBe(false);
  });

  it("matches everything for an empty search", () => {
    expect(matchesSearch("anything", "")).toBe(true);
    expect(matchesSearch("anything", "   ")).toBe(true);
  });
});
