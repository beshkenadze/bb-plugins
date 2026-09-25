import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const SELECTION = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" } as const;
const THREAD_INPUT = { requestId: "req-1", text: "fix the login bug", threadId: "thread-1" };
const NEW_THREAD_INPUT = { requestId: "req-1", text: "fix the login bug" };
const PERSONAL_WORKSPACE = { type: "host", workspace: { type: "personal" } };

type HostOptions = NonNullable<Parameters<typeof createFakePluginHost>[0]>;
type Harness = Awaited<ReturnType<typeof load>>;

function stubs() {
  return {
    providers: {
      list: async () => [
        { id: "codex", available: false },
        { id: "claude-code", available: true },
      ],
      models: async () => ({
        models: [
          { model: "claude-sonnet-5", isDefault: false, defaultReasoningEffort: "high" },
          { model: "claude-haiku-4-5", isDefault: true, defaultReasoningEffort: "low" },
        ],
      }),
    },
    threads: {
      timeline: async (): Promise<{ rows: unknown[] }> => ({ rows: [] }),
      list: async (): Promise<unknown[]> => [],
      spawn: async () => makeThreadResponse({ id: "worker-1", visibility: "hidden" }),
      wait: async (): Promise<unknown> => ({ matched: true }),
      output: async (): Promise<{ output: string | null }> => ({
        output: "<prompt>Fix the login bug in auth.ts</prompt>",
      }),
      archive: async () => ({ ok: true, archivedThreadIds: [] }),
      stop: async (): Promise<unknown> => ({ ok: true }),
    },
  } satisfies HostOptions["sdk"];
}

async function load(sdk: HostOptions["sdk"] = stubs(), settings: HostOptions["settings"] = {}) {
  const host = createFakePluginHost({ pluginId: "prompt-prewalk", sdk, settings });
  await plugin(host.bb);
  return host.harness;
}

async function loadWithModel(sdk?: HostOptions["sdk"], settings?: HostOptions["settings"]) {
  const harness = await load(sdk, settings);
  await harness.callRpc("setModel", SELECTION);
  return harness;
}

function argsOf(harness: Harness, path: string): unknown[] {
  return harness.inspection.sdk.callsTo(path).map((args) => args[0]);
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: Error) => void = () => {};
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("getModel / setModel", () => {
  it("offers the default model of the first available provider until one is saved", async () => {
    const harness = await load();
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: SELECTION, saved: false });
    expect(argsOf(harness, "providers.models")).toEqual([{ providerId: "claude-code" }]);
  });

  it("returns the saved selection", async () => {
    const harness = await load();
    const sonnet = { ...SELECTION, model: "claude-sonnet-5" };
    await expect(harness.callRpc("setModel", sonnet)).resolves.toEqual(sonnet);
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: sonnet, saved: true });
  });

  it("offers nothing when no provider is available", async () => {
    const sdk = stubs();
    sdk.providers.list = async () => [];
    const harness = await load(sdk);
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: null, saved: false });
  });

  function withClaudeCatalog(claudeModels: () => Promise<{ models: never[] }>) {
    const sdk = stubs();
    sdk.providers.list = async () => [
      { id: "claude-code", available: true },
      { id: "codex", available: true },
    ];
    sdk.providers.models = async (args?: { providerId?: string }) =>
      args?.providerId === "claude-code"
        ? claudeModels()
        : { models: [{ model: "gpt-5.5", isDefault: true, defaultReasoningEffort: "medium" }] };
    return sdk;
  }

  const CODEX_DEFAULT = {
    selection: { providerId: "codex", model: "gpt-5.5", reasoningLevel: "medium" },
    saved: false,
  };

  it("skips an available provider with an empty catalog", async () => {
    const harness = await load(withClaudeCatalog(async () => ({ models: [] })));
    await expect(harness.callRpc("getModel")).resolves.toEqual(CODEX_DEFAULT);
    expect(argsOf(harness, "providers.models")).toEqual([{ providerId: "claude-code" }, { providerId: "codex" }]);
  });

  it("skips and logs a provider whose catalog call fails", async () => {
    const harness = await load(withClaudeCatalog(() => Promise.reject(new Error("auth required"))));
    await expect(harness.callRpc("getModel")).resolves.toEqual(CODEX_DEFAULT);
    expect(harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringContaining("auth required"),
    });
  });

  it("falls back to the first model when the catalog has no default", async () => {
    const sdk = stubs();
    sdk.providers.models = async () => ({
      models: [
        { model: "claude-sonnet-5", isDefault: false, defaultReasoningEffort: "high" },
        { model: "claude-haiku-4-5", isDefault: false, defaultReasoningEffort: "low" },
      ],
    });
    const harness = await load(sdk);
    await expect(harness.callRpc("getModel")).resolves.toEqual({
      selection: { providerId: "claude-code", model: "claude-sonnet-5", reasoningLevel: "high" },
      saved: false,
    });
  });

  it("keeps the picker's service tier", async () => {
    const harness = await load();
    const fast = { ...SELECTION, serviceTier: "fast" } as const;
    await expect(harness.callRpc("setModel", fast)).resolves.toEqual(fast);
    await expect(harness.callRpc("getModel")).resolves.toEqual({ selection: fast, saved: true });
  });

  it("rejects an unknown reasoning level", async () => {
    const harness = await load();
    await expect(
      harness.callRpc("setModel", { ...SELECTION, reasoningLevel: "extreme" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});

describe("improve", () => {
  it("asks for a model when none is saved", async () => {
    const harness = await load();
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toMatchObject({ ok: false, code: "no_model" });
    expect(argsOf(harness, "threads.spawn")).toEqual([]);
  });

  it("spawns a hidden worker in an isolated personal workspace and returns the rewritten prompt", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toEqual({
      ok: true,
      text: "Fix the login bug in auth.ts",
    });
    const [spawn] = argsOf(harness, "threads.spawn");
    expect(spawn).toMatchObject({
      projectId: "proj_personal",
      environment: PERSONAL_WORKSPACE,
      visibility: "hidden",
      permissionMode: "accept-edits",
      pluginMetadata: { prewalk: true },
      ...SELECTION,
    });
    expect(spawn).not.toHaveProperty("parentThreadId");
    expect(argsOf(harness, "threads.get")).toEqual([]);
    expect(argsOf(harness, "threads.wait")).toEqual([{ threadId: "worker-1", status: "idle", timeoutMs: 120_000 }]);
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
  });

  it("passes timeoutSec and extraInstructions from settings", async () => {
    const harness = await loadWithModel(stubs(), { timeoutSec: 30, extraInstructions: "Answer in English." });
    await harness.callRpc("improve", THREAD_INPUT);
    expect(argsOf(harness, "threads.wait")).toEqual([{ threadId: "worker-1", status: "idle", timeoutMs: 30_000 }]);
    expect(argsOf(harness, "threads.spawn")[0]).toMatchObject({
      prompt: expect.stringContaining("\nAnswer in English.\n"),
    });
  });

  it("feeds recent thread history and the draft into the worker prompt", async () => {
    const sdk = stubs();
    sdk.threads.timeline = async () => ({
      rows: [
        { kind: "conversation", role: "user", initiator: "user", id: "m1", text: "earlier question" },
        { kind: "conversation", role: "assistant", id: "m2", text: "earlier answer" },
      ],
    });
    const harness = await loadWithModel(sdk);
    await harness.callRpc("improve", THREAD_INPUT);
    const [spawn] = argsOf(harness, "threads.spawn");
    expect(spawn).toMatchObject({ prompt: expect.stringContaining("<assistant>\nearlier answer\n</assistant>") });
    expect(spawn).toMatchObject({ prompt: expect.stringContaining("<draft>\nfix the login bug\n</draft>") });
  });

  it("skips history when historyMessages is 0", async () => {
    const harness = await loadWithModel(stubs(), { historyMessages: 0 });
    await harness.callRpc("improve", THREAD_INPUT);
    expect(argsOf(harness, "threads.timeline")).toEqual([]);
  });

  it("runs a new-thread draft without history", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("improve", NEW_THREAD_INPUT)).resolves.toMatchObject({ ok: true });
    expect(argsOf(harness, "threads.spawn")[0]).toMatchObject({ environment: PERSONAL_WORKSPACE });
    expect(argsOf(harness, "threads.timeline")).toEqual([]);
  });

  it.each([
    ["invalid_response", { output: async () => ({ output: "Sure! Here is a better prompt." }) }],
    ["timeout", { wait: async () => Promise.reject(namedError("ThreadWaitTimeoutError")) }],
    ["worker_failed", { wait: async () => Promise.reject(namedError("ThreadWaitUnreachableError")) }],
  ] as const)("reports %s and cleans up the worker", async (code, threadOverrides) => {
    const sdk = stubs();
    Object.assign(sdk.threads, threadOverrides);
    const harness = await loadWithModel(sdk);
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toMatchObject({ ok: false, code });
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
  });

  it("cleans up the worker when an unexpected error escapes", async () => {
    const sdk = stubs();
    sdk.threads.output = async () => Promise.reject(new Error("boom"));
    const harness = await loadWithModel(sdk);
    await expect(harness.callRpc("improve", THREAD_INPUT)).rejects.toThrow("boom");
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
  });

  it("keeps the result and still stops the worker when archive fails", async () => {
    const sdk = stubs();
    sdk.threads.archive = async () => Promise.reject(new Error("archive refused"));
    const harness = await loadWithModel(sdk);
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toEqual({
      ok: true,
      text: "Fix the login bug in auth.ts",
    });
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
    expect(harness.inspection.logEntries).toContainEqual({
      level: "warn",
      message: expect.stringContaining("archive refused"),
    });
  });

  it("rejects unknown input keys", async () => {
    const harness = await loadWithModel();
    await expect(
      harness.callRpc("improve", { ...THREAD_INPUT, projectId: "project-1" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("rejects a blank draft", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("improve", { ...THREAD_INPUT, text: "   " })).rejects.toMatchObject({
      code: "invalid_input",
    });
  });
});

describe("cancel and dispose", () => {
  function blockingStubs() {
    let release = () => {};
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const sdk = stubs();
    sdk.threads.wait = async () => {
      await released;
      return { matched: true };
    };
    sdk.threads.stop = async () => {
      release();
      return { ok: true };
    };
    return sdk;
  }

  async function cancelWhileBlocked(harness: Harness, path: string, release: () => void) {
    const pending = harness.callRpc("improve", THREAD_INPUT);
    await vi.waitFor(() => expect(argsOf(harness, path)).toHaveLength(1));
    await expect(harness.callRpc("cancel", { requestId: "req-1" })).resolves.toEqual({ cancelled: true });
    release();
    return pending;
  }

  it("stops the worker and resolves the request as cancelled", async () => {
    const harness = await loadWithModel(blockingStubs());
    const pending = harness.callRpc("improve", THREAD_INPUT);
    await vi.waitFor(() => expect(argsOf(harness, "threads.wait")).toHaveLength(1));
    await expect(harness.callRpc("cancel", { requestId: "req-1" })).resolves.toEqual({ cancelled: true });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
  });

  it("cancel issued right after improve still cancels it", async () => {
    const harness = await loadWithModel();
    const pending = harness.callRpc("improve", THREAD_INPUT);
    const cancelled = harness.callRpc("cancel", { requestId: "req-1" });
    await expect(cancelled).resolves.toEqual({ cancelled: true });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(argsOf(harness, "threads.spawn")).toEqual([]);
  });

  it("a finished request does not unregister a newer one with the same id", async () => {
    const sdk = blockingStubs();
    sdk.threads.timeline = async () => Promise.reject(new Error("timeline down"));
    const harness = await loadWithModel(sdk);
    const first = harness.callRpc("improve", { ...THREAD_INPUT, requestId: "dup" });
    const second = harness.callRpc("improve", { ...NEW_THREAD_INPUT, requestId: "dup" });
    await expect(first).rejects.toThrow("timeline down");
    await expect(harness.callRpc("cancel", { requestId: "dup" })).resolves.toEqual({ cancelled: true });
    await expect(second).resolves.toMatchObject({ ok: false, code: "cancelled" });
  });

  it("an error after cancel resolves as cancelled", async () => {
    const spawn = deferred<ReturnType<typeof makeThreadResponse>>();
    const sdk = stubs();
    sdk.threads.spawn = () => spawn.promise;
    const harness = await loadWithModel(sdk);
    await expect(
      cancelWhileBlocked(harness, "threads.spawn", () => spawn.reject(new Error("spawn failed"))),
    ).resolves.toMatchObject({ ok: false, code: "cancelled" });
  });

  it("cancel while spawn is in flight stops the late worker without waiting", async () => {
    const spawn = deferred<ReturnType<typeof makeThreadResponse>>();
    const sdk = stubs();
    sdk.threads.spawn = () => spawn.promise;
    const harness = await loadWithModel(sdk);
    await expect(
      cancelWhileBlocked(harness, "threads.spawn", () =>
        spawn.resolve(makeThreadResponse({ id: "worker-1", visibility: "hidden" })),
      ),
    ).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(argsOf(harness, "threads.wait")).toEqual([]);
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
    expect(argsOf(harness, "threads.stop")).toEqual([{ threadId: "worker-1" }]);
  });

  it("cancel while reading history skips the spawn", async () => {
    const timeline = deferred<{ rows: unknown[] }>();
    const sdk = stubs();
    sdk.threads.timeline = () => timeline.promise;
    const harness = await loadWithModel(sdk);
    await expect(
      cancelWhileBlocked(harness, "threads.timeline", () => timeline.resolve({ rows: [] })),
    ).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(argsOf(harness, "threads.spawn")).toEqual([]);
  });

  it("treats cancel of an unknown request as a no-op", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("cancel", { requestId: "nope" })).resolves.toEqual({ cancelled: false });
  });

  it("stops in-flight workers on dispose", async () => {
    const harness = await loadWithModel(blockingStubs());
    const pending = harness.callRpc("improve", THREAD_INPUT);
    await vi.waitFor(() => expect(argsOf(harness, "threads.wait")).toHaveLength(1));
    await harness.lifecycle.dispose();
    expect(argsOf(harness, "threads.stop")).toContainEqual({ threadId: "worker-1" });
    await expect(pending).resolves.toMatchObject({ ok: false, code: "cancelled" });
    expect(argsOf(harness, "threads.archive")).toEqual([{ threadId: "worker-1" }]);
  });
});
