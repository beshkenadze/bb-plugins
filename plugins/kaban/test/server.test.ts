import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BoardSnapshot, KabanTask } from "../src/model.js";
import plugin, { BOARD_CHANGED } from "../server.js";
import { FakeKaban } from "./fake-kaban.js";

const PROJECT = {
  id: "proj_1",
  name: "Demo",
  kind: "standard",
  sources: [
    { hostId: "host_a", path: "/repo", isDefault: true },
    { hostId: "host_b", path: "/srv/repo", isDefault: false },
  ],
};

const THREADS: Record<string, { environmentId: string | null; providerId: string }> = {
  thr_b: { environmentId: "env_b", providerId: "codex" },
  thr_c: { environmentId: "env_c", providerId: "claude-code" },
};

const ENVIRONMENTS: Record<string, { hostId: string; path: string | null }> = {
  // A managed worktree on host_b: the board must come from host_b's checkout.
  env_b: { hostId: "host_b", path: "/srv/worktrees/feature" },
  // A machine with no project checkout: falls back to the thread workspace.
  env_c: { hostId: "host_c", path: "/c/workspace" },
};

interface SpawnArgs {
  projectId: string;
  prompt: string;
  title: string;
  environment: { type: string; hostId?: string; workspace?: { type: string; path?: string } };
}

async function setup(options: { runDelayMs?: number } = {}) {
  const kaban = new FakeKaban();
  const spawned: SpawnArgs[] = [];
  const threads = { ...THREADS };
  const environments = { ...ENVIRONMENTS };
  // Track overlapping kaban runs per board to prove the plugin serializes them.
  const concurrency = { running: new Map<string, number>(), max: 0 };
  const handle = async (call: Parameters<FakeKaban["handle"]>[0]) => {
    if (call.method !== "run" || options.runDelayMs === undefined) return kaban.handle(call);
    const key = `${call.hostId}:${String((call.input as { root: string }).root)}`;
    const now = (concurrency.running.get(key) ?? 0) + 1;
    concurrency.running.set(key, now);
    concurrency.max = Math.max(concurrency.max, now);
    await new Promise((resolve) => setTimeout(resolve, options.runDelayMs));
    concurrency.running.set(key, (concurrency.running.get(key) ?? 1) - 1);
    return kaban.handle(call);
  };
  const { bb, harness } = createFakePluginHost({
    pluginId: "kaban",
    experimental_callHostRpc: handle,
    sdk: {
      projects: {
        get: async ({ projectId }: { projectId: string }) => {
          if (projectId !== PROJECT.id) throw new Error(`HTTP 404: unknown project ${projectId}`);
          return PROJECT;
        },
        list: async () => [PROJECT],
      },
      threads: {
        get: async ({ threadId }: { threadId: string }) => {
          const thread = threads[threadId];
          if (thread === undefined) throw new Error(`HTTP 404: unknown thread ${threadId}`);
          return { id: threadId, projectId: PROJECT.id, title: `Thread ${threadId}`, status: "idle", archivedAt: null, ...thread };
        },
        // Like BB: a `host` environment lands on exactly that machine.
        spawn: async (args: SpawnArgs) => {
          spawned.push(args);
          const id = `thr_new${spawned.length}`;
          const { environment } = args;
          if (environment.type === "host" && environment.hostId !== undefined) {
            const path =
              environment.workspace?.type === "unmanaged"
                ? (environment.workspace.path ?? null)
                : `/worktrees/${id}`;
            environments[`env_${id}`] = { hostId: environment.hostId, path };
            threads[id] = { environmentId: `env_${id}`, providerId: "claude-code" };
          } else {
            // project-default would pick the project's default machine (host_a).
            environments[`env_${id}`] = { hostId: "host_a", path: `/worktrees/${id}` };
            threads[id] = { environmentId: `env_${id}`, providerId: "claude-code" };
          }
          return { id, providerId: "claude-code" };
        },
      },
      environments: {
        get: async ({ environmentId }: { environmentId: string }) => {
          const environment = environments[environmentId];
          if (environment === undefined) throw new Error("HTTP 404");
          return { id: environmentId, ...environment };
        },
      },
    } as never,
  });
  await plugin(bb);
  return { kaban, harness, spawned, concurrency };
}

type Harness = Awaited<ReturnType<typeof setup>>["harness"];

const byProject = { scope: { projectId: "proj_1", threadId: null } };
const boardChanges = (harness: Harness) =>
  harness.inspection.realtimeSignals.filter((signal) => signal.channel === BOARD_CHANGED);

describe("board snapshot", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });
  afterEach(() => ctx.harness.lifecycle.dispose());

  it("reads the project's default checkout and watches it once", async () => {
    ctx.kaban.init("host_a", "/repo", "Demo board");
    ctx.kaban.seed("host_a", "/repo", "Write docs");
    const snapshot = (await ctx.harness.behavior.callRpc("board_get", byProject)) as BoardSnapshot;
    expect(snapshot.state).toBe("ready");
    if (snapshot.state !== "ready") return;
    expect(snapshot.target).toMatchObject({ hostId: "host_a", root: "/repo", via: "project-source" });
    expect(snapshot.status.name).toBe("Demo board");
    expect(snapshot.tasks.map((task) => task.title)).toEqual(["Write docs"]);
    await ctx.harness.behavior.callRpc("board_get", byProject);
    expect(ctx.kaban.watches).toEqual([{ hostId: "host_a", root: "/repo" }]);
  });

  it("resolves a worktree thread to its project checkout on the same machine", async () => {
    ctx.kaban.init("host_b", "/srv/repo");
    const snapshot = (await ctx.harness.behavior.callRpc("board_get", { scope: { projectId: null, threadId: "thr_b" } })) as BoardSnapshot;
    expect(snapshot.state === "ready" && snapshot.target).toMatchObject({ hostId: "host_b", root: "/srv/repo" });
  });

  it("falls back to the thread workspace when its machine has no checkout", async () => {
    ctx.kaban.init("host_c", "/c/workspace");
    const snapshot = (await ctx.harness.behavior.callRpc("board_get", { scope: { projectId: null, threadId: "thr_c" } })) as BoardSnapshot;
    expect(snapshot.state === "ready" && snapshot.target).toMatchObject({ hostId: "host_c", root: "/c/workspace", via: "environment" });
  });

  it("reports a missing board as unavailable with an init hint", async () => {
    const snapshot = (await ctx.harness.behavior.callRpc("board_get", byProject)) as BoardSnapshot;
    expect(snapshot).toMatchObject({ state: "unavailable", code: "no_board" });
    expect(snapshot.state === "unavailable" && snapshot.message).toContain("kaban init");
  });

  it("reports a missing kaban CLI as not_installed", async () => {
    ctx.kaban.notInstalled = true;
    const snapshot = (await ctx.harness.behavior.callRpc("board_get", byProject)) as BoardSnapshot;
    expect(snapshot).toMatchObject({ state: "unavailable", code: "not_installed" });
  });
});

describe("mutations", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    ctx.kaban.init("host_a", "/repo");
  });
  afterEach(() => ctx.harness.lifecycle.dispose());

  it("passes user text after `--` so it is never parsed as a flag, and notifies boards", async () => {
    const result = (await ctx.harness.behavior.callRpc("task_add", {
      ...byProject,
      title: "--force everything",
      description: "-x",
      column: null,
      force: false,
    })) as { task: KabanTask };
    expect(result.task.title).toBe("--force everything");
    expect(result.task.description).toBe("-x");
    expect(ctx.kaban.runs.at(-1)?.args).toEqual(["add", "--json", "--description=-x", "--", "--force everything"]);
    expect(boardChanges(ctx.harness)).toEqual([{ channel: BOARD_CHANGED, payload: { projectId: "proj_1" } }]);
  });

  it("surfaces kaban's duplicate guard as an RPC error", async () => {
    ctx.kaban.seed("host_a", "/repo", "Same");
    await expect(
      ctx.harness.behavior.callRpc("task_add", { ...byProject, title: "Same", description: null, column: null, force: false }),
    ).rejects.toThrow(/similar task/u);
  });

  it("starts a thread from a task, links it, and moves it to the start column", async () => {
    ctx.kaban.seed("host_a", "/repo", "Fix login");
    const result = (await ctx.harness.behavior.callRpc("task_start_thread", { ...byProject, taskId: "1", note: "Keep it small." })) as {
      threadId: string;
      task: KabanTask;
      warning: string | null;
    };
    expect(result).toMatchObject({ threadId: "thr_new1", warning: null });
    expect(result.task).toMatchObject({ columnId: "in_progress", assignedTo: "claude-code" });
    const spawn = ctx.spawned[0];
    expect(spawn?.projectId).toBe("proj_1");
    expect(spawn?.environment).toMatchObject({ type: "host", hostId: "host_a" });
    expect(spawn?.title).toBe("#1 Fix login");
    expect(spawn?.prompt).toContain("Fix login");
    expect(spawn?.prompt).toContain("Keep it small.");
    expect(spawn?.prompt).toContain("bb kaban done 1");
    expect(await ctx.harness.behavior.callRpc("thread_link_get", { threadId: "thr_new1" })).toEqual({
      taskId: "01TASK0001",
      projectId: "proj_1",
    });
  });
});

describe("task threads stay on the board's machine", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    // Both machines have a checkout with its own board; the project default is host_a.
    ctx.kaban.init("host_a", "/repo", "A board");
    ctx.kaban.seed("host_a", "/repo", "Task on A");
    ctx.kaban.init("host_b", "/srv/repo", "B board");
    ctx.kaban.seed("host_b", "/srv/repo", "Task on B");
  });
  afterEach(() => ctx.harness.lifecycle.dispose());

  it("pins a thread started from host_b's board to host_b, so it works against that same board", async () => {
    ctx.kaban.gitRoots.add("host_b:/srv/repo");
    const result = (await ctx.harness.behavior.callRpc("task_start_thread", {
      scope: { projectId: null, threadId: "thr_b" },
      taskId: "1",
      note: null,
    })) as { threadId: string; task: KabanTask };
    expect(result.task.title).toBe("Task on B");
    expect(ctx.spawned[0]?.environment).toEqual({
      type: "host",
      hostId: "host_b",
      workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
    });

    // The new thread's own `bb kaban` reads host_b's board, where its task lives.
    const current = await ctx.harness.behavior.runCli(["current", "--json"], { threadId: result.threadId });
    expect(JSON.parse(current.stdout)).toMatchObject({ task: { title: "Task on B", columnId: "in_progress" } });
    const status = await ctx.harness.behavior.runCli(["status", "--json"], { threadId: result.threadId });
    expect(JSON.parse(status.stdout)).toMatchObject({ target: { hostId: "host_b", root: "/srv/repo" }, status: { name: "B board" } });
  });

  it("runs in the board root itself when it is not a git checkout", async () => {
    await ctx.harness.behavior.callRpc("task_start_thread", { scope: { projectId: null, threadId: "thr_b" }, taskId: "1", note: null });
    expect(ctx.spawned[0]?.environment).toEqual({
      type: "host",
      hostId: "host_b",
      workspace: { type: "unmanaged", path: "/srv/repo" },
    });
    const current = await ctx.harness.behavior.runCli(["current", "--json"], { threadId: "thr_new1" });
    expect(JSON.parse(current.stdout)).toMatchObject({ task: { title: "Task on B" } });
  });

  it("keeps a thread-workspace board in that workspace on its machine", async () => {
    ctx.kaban.init("host_c", "/c/workspace", "C board");
    ctx.kaban.seed("host_c", "/c/workspace", "Task on C");
    await ctx.harness.behavior.callRpc("task_start_thread", { scope: { projectId: null, threadId: "thr_c" }, taskId: "1", note: null });
    expect(ctx.spawned[0]?.environment).toEqual({
      type: "host",
      hostId: "host_c",
      workspace: { type: "unmanaged", path: "/c/workspace" },
    });
    const current = await ctx.harness.behavior.runCli(["current", "--json"], { threadId: "thr_new1" });
    expect(JSON.parse(current.stdout)).toMatchObject({ task: { title: "Task on C" } });
  });
});

describe("bb kaban CLI", () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
    ctx.kaban.init("host_b", "/srv/repo");
    ctx.kaban.seed("host_b", "/srv/repo", "Ship it");
  });
  afterEach(() => ctx.harness.lifecycle.dispose());

  it("never guesses a board from cwd: it fails before running kaban and suggests --project", async () => {
    const result = await ctx.harness.behavior.runCli(["list"], { cwd: "/srv/repo/src" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--project proj_1");
    expect(ctx.kaban.runs).toEqual([]);
    const json = await ctx.harness.behavior.runCli(["list", "--json"], { cwd: "/srv/repo/src" });
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, error: { code: "invalid" } });
  });

  it("uses the invoking thread's board and acts as its provider", async () => {
    const moved = await ctx.harness.behavior.runCli(["move", "#1", "review"], { threadId: "thr_b" });
    expect(moved.exitCode).toBe(0);
    expect(moved.stdout).toContain("[review]");
    expect(ctx.kaban.runs.at(-1)).toMatchObject({ hostId: "host_b", root: "/srv/repo", agent: "codex" });
  });

  it("links the invoking thread, injects instructions, and unlinks on delete", async () => {
    const linked = await ctx.harness.behavior.runCli(["link", "1"], { threadId: "thr_b" });
    expect(linked.exitCode).toBe(0);
    const current = await ctx.harness.behavior.runCli(["current", "--json"], { threadId: "thr_b" });
    expect(JSON.parse(current.stdout)).toMatchObject({ task: { title: "Ship it" } });

    const instructions = ctx.harness.inspection.registrations.instructionProvider?.({ threadId: "thr_b", projectId: "proj_1" });
    expect(instructions).toContain("#1");
    expect(instructions).toContain("bb kaban move 1 review");
    expect(instructions).toContain(JSON.stringify("Ship it"));
    expect(ctx.harness.inspection.registrations.instructionProvider?.({ threadId: "thr_c", projectId: "proj_1" })).toBeNull();

    await ctx.harness.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: "thr_b" }) });
    expect(await ctx.harness.behavior.callRpc("thread_link_get", { threadId: "thr_b" })).toEqual({ taskId: null, projectId: null });
  });

  it("refuses to link a thread to a board other than its own, without side effects", async () => {
    // thr_c runs on host_c; --project proj_1 resolves to the default board on host_a.
    ctx.kaban.init("host_a", "/repo");
    ctx.kaban.seed("host_a", "/repo", "Task on A");
    ctx.kaban.init("host_c", "/c/workspace");
    ctx.kaban.seed("host_c", "/c/workspace", "Task on C");

    const refused = await ctx.harness.behavior.runCli(["link", "1", "--project", "proj_1", "--json"], { threadId: "thr_c" });
    expect(refused.exitCode).not.toBe(0);
    expect(JSON.parse(refused.stdout)).toMatchObject({ ok: false, error: { code: "invalid" } });
    expect(refused.stderr).toContain("bb kaban start");
    expect(await ctx.harness.behavior.callRpc("thread_link_get", { threadId: "thr_c" })).toEqual({ taskId: null, projectId: null });

    // add --link is validated before the task is created.
    const addRefused = await ctx.harness.behavior.runCli(["add", "Orphan", "--project", "proj_1", "--link"], { threadId: "thr_c" });
    expect(addRefused.exitCode).not.toBe(0);
    expect(ctx.kaban.board("host_a", "/repo")?.tasks.map((task) => task.title)).toEqual(["Task on A"]);

    // On its own board the same thread links, and `current` reads that board.
    expect((await ctx.harness.behavior.runCli(["link", "1"], { threadId: "thr_c" })).exitCode).toBe(0);
    const current = await ctx.harness.behavior.runCli(["current", "--json"], { threadId: "thr_c" });
    expect(JSON.parse(current.stdout)).toMatchObject({ task: { title: "Task on C" } });
  });

  it("requires a thread to link outside a thread", async () => {
    const result = await ctx.harness.behavior.runCli(["link", "1", "--project", "proj_1"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("--thread");
  });

  it("rejects ambiguous move arguments", async () => {
    const result = await ctx.harness.behavior.runCli(["move", "1", "review", "--next"], { threadId: "thr_b" });
    expect(result.exitCode).not.toBe(0);
    expect(ctx.kaban.runs).toEqual([]);
  });
});

describe("kaban process safety", () => {
  it("never runs two kaban commands against one board at once", async () => {
    const ctx = await setup({ runDelayMs: 5 });
    ctx.kaban.init("host_a", "/repo");
    ctx.kaban.init("host_b", "/srv/repo");
    // Several open boards, a CLI call, and a mutation all at once.
    await Promise.all([
      ctx.harness.behavior.callRpc("board_get", byProject),
      ctx.harness.behavior.callRpc("board_get", byProject),
      ctx.harness.behavior.callRpc("task_add", { ...byProject, title: "Parallel", description: null, column: null, force: false }),
      ctx.harness.behavior.runCli(["list", "--project", "proj_1"]),
      ctx.harness.behavior.callRpc("board_get", { scope: { projectId: null, threadId: "thr_b" } }),
    ]);
    expect(ctx.kaban.runs.length).toBeGreaterThanOrEqual(8);
    expect(ctx.concurrency.max).toBe(1);
    await ctx.harness.lifecycle.dispose();
  });

  it("drops a CLI mutation whose client disconnects while it waits for the board", async () => {
    const ctx = await setup({ runDelayMs: 20 });
    ctx.kaban.init("host_a", "/repo");
    const busy = ctx.harness.behavior.callRpc("board_get", byProject); // status + list occupy the board
    while (ctx.concurrency.max === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    const controller = new AbortController();
    const add = ctx.harness.behavior.runCli(["add", "Should not land", "--project", "proj_1"], { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5)); // queued behind the board read
    controller.abort();
    const result = await add;
    await busy;
    await new Promise((resolve) => setTimeout(resolve, 60)); // anything still queued would run by now
    expect(result.exitCode).not.toBe(0);
    expect(ctx.kaban.runs.some((run) => run.args[0] === "add")).toBe(false);
    expect(ctx.kaban.board("host_a", "/repo")?.tasks).toEqual([]);
    await ctx.harness.lifecycle.dispose();
  });
});

describe("live refresh", () => {
  it("routes host file-change signals to the projects open on that board", async () => {
    const ctx = await setup();
    ctx.kaban.init("host_a", "/repo");
    await ctx.harness.behavior.callRpc("board_get", byProject);
    await ctx.harness.behavior.experimental_emitHostSignal("host_a", "boardChanged", { root: "/somewhere/else" });
    expect(boardChanges(ctx.harness)).toEqual([]);
    await ctx.harness.behavior.experimental_emitHostSignal("host_a", "boardChanged", { root: "/repo" });
    expect(boardChanges(ctx.harness)).toEqual([{ channel: BOARD_CHANGED, payload: { projectId: "proj_1" } }]);
    await ctx.harness.lifecycle.dispose();
  });
});
