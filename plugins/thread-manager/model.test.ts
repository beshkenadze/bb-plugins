import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS, filterThreads, selectedOnPage, statusLabel, UNSECTIONED, updateMany } from "./model";
import { projects, sections, thread } from "./test/fixtures";

const names = new Map([["codex", "Codex"]]);
const filter = (rows: ReturnType<typeof thread>[], patch: Partial<typeof DEFAULT_FILTERS> = {}) => filterThreads(rows, { ...DEFAULT_FILTERS, ...patch }, projects, sections, names).map((row) => row.id);

describe("thread search and scope", () => {
  it("excludes archives, hidden helpers, and other projects unless requested", () => {
    const rows = [thread("a"), thread("hidden", { isHidden: true }), thread("archive", { isArchived: true }), thread("b", { projectId: "project-b" })];
    expect(filter(rows, { projectId: "project-a" })).toEqual(["a"]);
    expect(filter(rows, { lifecycle: "all", showHidden: true, projectId: "project-a" })).toEqual(["a", "archive", "hidden"]);
    expect(filter(rows, { lifecycle: "archived" })).toEqual(["archive"]);
  });
  it("matches all search terms across resolved metadata, not only titles", () => {
    const branch = thread("branch", { sectionId: "later", environment: { id: "env", name: "Worktree", branchName: "feature/search", path: "/work/repo", isWorktree: true, providerId: null, workspaceDisplayKind: null } });
    expect(filter([branch, thread("other")], { query: "ALPHA codex feature/search later mini" })).toEqual(["branch"]);
    expect(filter([branch], { query: "nonexistent" })).toEqual([]);
  });
  it("combines section, parent, provider, host, and status filters", () => {
    const rows = [thread("root", { status: "active", runtimeStatus: "active", sectionId: "later" }), thread("child", { parentThreadId: "root" }), thread("error", { status: "error", runtimeStatus: "error" })];
    expect(filter(rows, { preset: "running", sectionId: "later", providerId: "codex", hostId: "mac", rootsOnly: true })).toEqual(["root"]);
    expect(filter(rows, { preset: "attention", sectionId: UNSECTIONED })).toEqual(["error"]);
    expect(statusLabel(rows[2]!)).toBe("Failed");
  });
  it("sorts a copy and keeps stable ordering when timestamps tie", () => {
    const rows = [thread("z", { displayTitle: "Zulu" }), thread("a", { displayTitle: "Alpha", updatedAt: 2_000_000_000_000 })];
    expect(filter(rows)).toEqual(["a", "z"]);
    expect(filter(rows, { sort: "title" })).toEqual(["a", "z"]);
    expect(rows.map((row) => row.id)).toEqual(["z", "a"]);
  });
});

describe("bulk writes", () => {
  it("ignores stale and off-page selections before a write", () => {
    expect(selectedOnPage([thread("visible")], new Set(["visible", "filtered-out", "deleted"])).map((row) => row.id)).toEqual(["visible"]);
  });
  it("accounts for partial and synchronous failures while updating remaining threads", async () => {
    const visited: string[] = [];
    const result = await updateMany([thread("a"), thread("b"), thread("c")], async (row) => {
      visited.push(row.id);
      if (row.id === "b") throw new Error("Machine offline");
    });
    expect(visited).toEqual(["a", "b", "c"]);
    expect(result).toEqual({ succeeded: 2, failedIds: ["b"], firstError: "Machine offline" });
    expect(await updateMany([thread("a")], () => { throw new Error("Rejected synchronously"); })).toEqual({ succeeded: 0, failedIds: ["a"], firstError: "Rejected synchronously" });
  });
});
