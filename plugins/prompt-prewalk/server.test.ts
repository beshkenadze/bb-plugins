import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server";

const SELECTION = { providerId: "claude-code", model: "claude-haiku-4-5", reasoningLevel: "low" } as const;
const THREAD_INPUT = { requestId: "req-1", text: "fix the login bug", threadId: "thread-1" };
const PROJECT_INPUT = { requestId: "req-1", text: "fix the login bug", projectId: "project-1" };

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
      get: async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: "env-1" }),
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

  it("spawns a hidden worker in the thread's environment and returns the rewritten prompt", async () => {
    const harness = await loadWithModel();
    await expect(harness.callRpc("improve", THREAD_INPUT)).resolves.toEqual({
      ok: true,
      text: "Fix the login bug in auth.ts",
    });
    const [spawn] = argsOf(harness, "threads.spawn");
    expect(spawn).toMatchObject({
      projectId: "project-1",
      environment: { type: "reuse", environmentId: "env-1" },
      visibility: "hidden",
      permissionMode: "accept-edits",
      pluginMetadata: { prewalk: true },
      ...SELECTION,
    });
    expect(spawn).not.toHaveProperty("parentThreadId");
    expect(argsOf(harness, "threads.wait")).toEqual([{ threadId: "worker-1", status: "idle", timeoutMs: 120_000 }]);
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

  it("uses the project default environment for a new thread", async () => {
    const harness = await loadWithModel();
    await harness.callRpc("improve", PROJECT_INPUT);
    expect(argsOf(harness, "threads.spawn")[0]).toMatchObject({
      projectId: "project-1",
      environment: { type: "project-default" },
    });
    expect(argsOf(harness, "threads.get")).toEqual([]);
  });

  it("falls back to the project default environment when the thread has none", async () => {
    const sdk = stubs();
    sdk.threads.get = async () => makeThreadResponse({ id: "thread-1", projectId: "project-1", environmentId: null });
    const harness = await loadWithModel(sdk);
    await harness.callRpc("improve", THREAD_INPUT);
    expect(argsOf(harness, "threads.spawn")[0]).toMatchObject({ environment: { type: "project-default" } });
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

  it("rejects input with both threadId and projectId", async () => {
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
