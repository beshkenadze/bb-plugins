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

  it("rejects an unknown reasoning level", async () => {
    const harness = await load();
    await expect(
      harness.callRpc("setModel", { ...SELECTION, reasoningLevel: "extreme" }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });
});
