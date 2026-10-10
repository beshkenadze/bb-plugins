import { createFakePluginHost, experimental_scanPublicSdkOnly, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import plugin from "./server";

const MODEL = { providerId: "claude-code", model: "summary-model", reasoningLevel: "low", serviceTier: "custom-tier" } as const;
const INPUT = { requestId: "request-1", threadId: "source-thread", short: true };
type Options = NonNullable<Parameters<typeof createFakePluginHost>[0]>;
const hosts: ReturnType<typeof createFakePluginHost>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const host of hosts.splice(0)) await host.harness.lifecycle.dispose(); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}
function sdkStubs() {
  return {
    providers: {
      list: async () => [{ id: "claude-code", available: true }],
      models: async () => ({ models: [{ model: "summary-model", isDefault: true, defaultReasoningEffort: "low" }] }),
    },
    threads: {
      get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", runtime: { displayStatus: "idle" } }),
      timeline: async () => ({ rows: [{ id: "m1", kind: "conversation", role: "user", initiator: "user", text: "Fix login in src/auth.ts", sourceSeqStart: 1 }], maxSeq: 1, timelinePage: { hasOlderRows: false, olderCursor: null } }),
      list: async (): Promise<unknown[]> => [],
      spawn: async () => makeThreadResponse({ id: "recap-worker", visibility: "hidden" }),
      wait: async (_args: { signal?: AbortSignal }): Promise<unknown> => ({ matched: true }),
      output: async () => ({ output: "<recap>## Context\nFix login\n## Decisions\nNone recorded</recap>" }),
      archive: async (): Promise<unknown> => ({ ok: true }),
      stop: async (): Promise<unknown> => ({ ok: true }),
    },
  } satisfies Options["sdk"];
}
async function load(sdk: Options["sdk"] = sdkStubs(), saveModel = true, settings: Options["settings"] = {}) {
  const host = createFakePluginHost({ pluginId: "recap", sdk, settings, agentSkillIds: ["recap"] });
  hosts.push(host);
  await plugin(host.bb);
  if (saveModel) await host.harness.behavior.callRpc("setModel", MODEL);
  return host.harness;
}
function args(harness: Awaited<ReturnType<typeof load>>, path: string) {
  return harness.inspection.sdk.callsTo(path).map((call) => call[0]);
}

describe("model settings", () => {
  it("suggests a live default but requires an explicitly saved model before generating", async () => {
    const host = await load(undefined, false);
    await expect(host.behavior.callRpc("getModel")).resolves.toEqual({ saved: false, selection: { providerId: "claude-code", model: "summary-model", reasoningLevel: "low" } });
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: false, code: "no_model" });
    expect(args(host, "threads.spawn")).toHaveLength(0);
  });
  it("saves every picker field including custom service tiers and persists through reload", async () => {
    const host = await load();
    const replacement = await host.lifecycle.reload(plugin);
    hosts.push(replacement);
    await expect(replacement.harness.behavior.callRpc("getModel")).resolves.toEqual({ saved: true, selection: MODEL });
  });
  it("reports no provider and retries another catalog after a failure", async () => {
    const sdk = sdkStubs();
    sdk.providers.list = async () => [{ id: "broken", available: true }, { id: "claude-code", available: true }];
    const host = await load(sdk, false);
    host.inspection.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => {
      if (providerId === "broken") throw new Error("catalog offline");
      return { models: [{ model: "summary-model", isDefault: true, defaultReasoningEffort: "low" }] };
    });
    await expect(host.behavior.callRpc("getModel")).resolves.toMatchObject({ selection: { providerId: "claude-code" } });
    host.inspection.sdk.stub("providers.list", async () => []);
    await expect(host.behavior.callRpc("getModel")).resolves.toEqual({ saved: false, selection: null });
  });
});

describe("recap generation", () => {
  it("uses independent model + personal hidden worker, returns text and never sends to the source", async () => {
    const host = await load();
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: true, coverage: { includedEntries: 1, hasOlder: false, sourceMaxSeq: 1 } });
    expect(args(host, "threads.spawn")).toEqual([expect.objectContaining({
      ...MODEL, projectId: "proj_personal", environment: { type: "host", workspace: { type: "personal" } },
      visibility: "hidden", pluginMetadata: { recapWorker: true, recapSourceThreadId: "source-thread" },
      prompt: expect.stringContaining("src/auth.ts"), originPluginId: "recap",
    })]);
    expect(args(host, "threads.archive")).toEqual([{ threadId: "recap-worker" }]);
    expect(args(host, "threads.stop")).toEqual([{ threadId: "recap-worker" }]);
    expect(args(host, "threads.send")).toHaveLength(0);
    expect(args(host, "threads.update")).toHaveLength(0);
  });
  it("defaults to a brief orientation while preserving explicit detailed output and separate caches", async () => {
    const host = await load();
    const brief = "We're fixing login. The current focus is src/auth.ts.";
    host.inspection.sdk.stub("threads.output", async () => ({ output: `<overview>${brief}</overview><recap>${brief}</recap>` }));
    await expect(host.behavior.callRpc("recap", { requestId: INPUT.requestId, threadId: INPUT.threadId })).resolves.toMatchObject({ ok: true, text: brief });
    expect(args(host, "threads.spawn")[0]).toMatchObject({ prompt: expect.stringContaining("exactly two short plain-text sentences") });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: { text: brief } });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId, short: false })).resolves.toMatchObject({ cached: null });
    const detailed = "## Context\nFix login\n## Next steps\nInspect src/auth.ts";
    host.inspection.sdk.stub("threads.output", async () => ({ output: `<recap>${detailed}</recap>` }));
    await expect(host.behavior.callRpc("recap", { ...INPUT, short: false })).resolves.toMatchObject({ ok: true, text: detailed });
    expect(args(host, "threads.spawn")[1]).toMatchObject({ prompt: expect.stringContaining("200–350 words") });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId, short: false })).resolves.toMatchObject({ cached: { text: detailed } });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: { text: brief } });
    expect(args(host, "threads.spawn")).toHaveLength(2);
  });
  it("marks old five-bullet cache versions stale and does not let their attempt marker block the new brief prompt", async () => {
    const fixture = createFakePluginHost({ pluginId: "recap", sdk: sdkStubs() });
    hosts.push(fixture);
    await plugin(fixture.bb);
    await fixture.harness.behavior.callRpc("setModel", MODEL);
    const key = JSON.stringify([1, MODEL.providerId, MODEL.model, MODEL.reasoningLevel, MODEL.serviceTier, 100_000, 120, "short", 2]);
    const legacy = { ok: true, text: "- Context\n- Decisions\n- Done\n- Open\n- Next", coverage: { totalEntries: 1, includedEntries: 1, omittedEntries: 0, shortenedEntries: 0, hasOlder: false, sourceMaxSeq: 1 } };
    const path = "recap-cache/thread/source-thread";
    await fixture.bb.storage.kv.set("recap-cache/index", [INPUT.threadId]);
    await fixture.bb.storage.kv.set(path, { threadId: INPUT.threadId, sourceMaxSeq: 1, visitedAt: Date.now(), attempted: { short: key } });
    await fixture.bb.storage.kv.set(`${path}/short`, { key, result: legacy });
    const replacement = await fixture.harness.lifecycle.reload(plugin);
    hosts.push(replacement);
    const host = replacement.harness;
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: true, cached: { text: legacy.text } });
    const brief = "We're fixing login. The current focus is src/auth.ts.";
    host.inspection.sdk.stub("threads.output", async () => ({ output: `<overview>${brief}</overview><recap>${brief}</recap>` }));
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: true, text: brief, fromCache: false });
    expect(args(host, "threads.spawn")).toHaveLength(1);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: false, cached: { text: brief } });
  });
  it("does not spawn on empty history", async () => {
    const host = await load();
    host.inspection.sdk.stub("threads.timeline", async () => ({ rows: [], maxSeq: 0, timelinePage: { hasOlderRows: false, olderCursor: null } }));
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: false, code: "empty_history" });
    expect(args(host, "threads.spawn")).toHaveLength(0);
  });
  it.each(["timeout", "worker_failed", "invalid_response"])("cleans up after %s", async (code) => {
    const host = await load();
    if (code === "invalid_response") host.inspection.sdk.stub("threads.output", async () => ({ output: "wrong answer" }));
    else host.inspection.sdk.stub("threads.wait", async () => { const error = new Error("failed"); error.name = code === "timeout" ? "ThreadWaitTimeoutError" : "ThreadWaitUnreachableError"; throw error; });
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: false, code });
    expect(args(host, "threads.archive")).toEqual([{ threadId: "recap-worker" }]);
    expect(args(host, "threads.stop")).toEqual([{ threadId: "recap-worker" }]);
  });
  it("still stops a worker when archiving fails", async () => {
    const host = await load();
    host.inspection.sdk.stub("threads.archive", async () => { throw new Error("archive unavailable"); });
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: true });
    expect(args(host, "threads.stop")).toEqual([{ threadId: "recap-worker" }]);
  });
  it("rejects duplicate ids and concurrent recaps of one thread, scopes cancel to the correct thread", async () => {
    const started = deferred<void>();
    const sdk = sdkStubs();
    sdk.threads.wait = async ({ signal }) => {
      started.resolve();
      if (!signal) throw new Error("Missing cancellation signal");
      return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); });
    };
    const host = await load(sdk);
    const running = host.behavior.callRpc("recap", INPUT);
    await started.promise;
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ code: "busy" });
    await expect(host.behavior.callRpc("recap", { ...INPUT, requestId: "new-id" })).resolves.toMatchObject({ code: "busy" });
    await expect(host.behavior.callRpc("cancel", { requestId: INPUT.requestId, threadId: "other" })).resolves.toEqual({ cancelled: false });
    await expect(host.behavior.callRpc("cancel", { requestId: INPUT.requestId, threadId: INPUT.threadId })).resolves.toEqual({ cancelled: true });
    await expect(running).resolves.toMatchObject({ code: "cancelled" });
  });
  it("cleans up a spawn that resolves after cancellation", async () => {
    const spawn = deferred<ReturnType<typeof makeThreadResponse>>();
    const started = deferred<void>();
    const sdk = sdkStubs();
    sdk.threads.spawn = async () => { started.resolve(); return spawn.promise; };
    const host = await load(sdk);
    const running = host.behavior.callRpc("recap", INPUT);
    await started.promise;
    await host.behavior.callRpc("cancel", { requestId: INPUT.requestId, threadId: INPUT.threadId });
    spawn.resolve(makeThreadResponse({ id: "late-worker", visibility: "hidden" }));
    await expect(running).resolves.toMatchObject({ code: "cancelled" });
    expect(args(host, "threads.stop")).toEqual([{ threadId: "late-worker" }]);
    expect(args(host, "threads.wait")).toHaveLength(0);
  });
  it("aborts history reads at the configured deadline without spawning", async () => {
    vi.useFakeTimers();
    const started = deferred<void>();
    const host = await load(undefined, true, { timeoutSec: 10 });
    host.inspection.sdk.stub("threads.timeline", async ({ signal }: { signal: AbortSignal }) => {
      started.resolve();
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const running = host.behavior.callRpc("recap", INPUT);
    await started.promise;
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(running).resolves.toMatchObject({ code: "timeout" });
    expect(args(host, "threads.spawn")).toHaveLength(0);
  });
  it("stops active workers on plugin disposal", async () => {
    const started = deferred<void>();
    const sdk = sdkStubs();
    sdk.threads.wait = async ({ signal }) => {
      started.resolve();
      if (!signal) throw new Error("Missing cancellation signal");
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    };
    const host = await load(sdk);
    const running = host.behavior.callRpc("recap", INPUT);
    await started.promise;
    await host.lifecycle.dispose();
    await expect(running).resolves.toMatchObject({ code: "cancelled" });
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "recap-worker" });
  });
  it("only reclaims old hidden workers owned by this plugin before generating", async () => {
    const sdk = sdkStubs();
    sdk.threads.list = async () => [makeThreadResponse({ id: "orphan", visibility: "hidden" }), makeThreadResponse({ id: "visible", visibility: "visible" })];
    const host = await load(sdk);
    await host.behavior.callRpc("recap", INPUT);
    expect(args(host, "threads.list")).toEqual([expect.objectContaining({ originPluginId: "recap", includeHidden: true, archived: false })]);
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "orphan" });
    expect(args(host, "threads.stop")).not.toContainEqual({ threadId: "visible" });
  });
  it("selects no recap skill for workers and contributes only readonly instructions", async () => {
    const host = await load();
    const resolved = await host.behavior.resolveAgentConfiguration(makePluginAgentConfigurationContext({ pluginMetadata: { recapWorker: true } }));
    expect(resolved).toMatchObject({ tools: [], skills: [], instructions: expect.stringContaining("Do not run tools") });
  });
});

describe("background Recap", () => {
  it("registers visits without generating, ignores polling, then produces one durable preview after 180s", async () => {
    vi.useFakeTimers();
    const host = await load();
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toEqual({ cached: null, stale: false, running: false, backgroundEnabled: true, sourceMaxSeq: 1 });
    await vi.advanceTimersByTimeAsync(100_000);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(79_999);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(args(host, "threads.spawn")).toHaveLength(1);
    expect(args(host, "threads.spawn")[0]).toMatchObject({ prompt: expect.stringContaining("exactly two short plain-text sentences") });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId, short: false })).resolves.toMatchObject({ cached: null });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: false, cached: { ok: true, preview: "Context Fix login Decisions None recorded", generatedAt: expect.any(Number), fromCache: true } });
    await host.behavior.callRpc("recap", INPUT);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("restores visits/results on reload, rechecks revision gaps and starts a new inactivity clock", async () => {
    vi.useFakeTimers();
    const host = await load();
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    const replacement = await host.lifecycle.reload(plugin);
    hosts.push(replacement);
    const restored = replacement.harness;
    // No mount/poll is needed to recover a persisted visit.
    restored.inspection.sdk.stub("threads.timeline", async () => ({ rows: [{ id: "m2", kind: "conversation", role: "user", text: "new work", sourceSeqStart: 2 }], maxSeq: 2, timelinePage: { hasOlderRows: false, olderCursor: null } }));
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(restored, "threads.spawn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(restored, "threads.spawn")).toHaveLength(1);
    await expect(restored.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: false, cached: { fromCache: true, coverage: { sourceMaxSeq: 2 } } });
  });
  it("reports the current probe revision independently of cached full/short coverage, or null when unavailable", async () => {
    const host = await load();
    await host.behavior.callRpc("recap", INPUT);
    host.inspection.sdk.stub("threads.timeline", async () => ({ rows: [], maxSeq: 9, timelinePage: { hasOlderRows: false, olderCursor: null } }));
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ sourceMaxSeq: 9, stale: true, cached: { coverage: { sourceMaxSeq: 1 } } });
    host.inspection.sdk.stub("threads.get", async () => { throw new Error("offline"); });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ sourceMaxSeq: null, stale: true });
  });
});

it("uses only public SDK imports", async () => {
  const scanned = await experimental_scanPublicSdkOnly(new URL(".", import.meta.url).pathname, {
    allow: [/^react(?:-dom)?(?:\/.*)?$/, /^@testing-library\/react$/, /^@radix-ui\/react-[a-z-]+$/, /^(?:class-variance-authority|clsx|tailwind-merge|vitest\/config)$/],
  });
  expect(scanned.violations).toEqual([]);
  expect(scanned.privateDependencies).toEqual([]);
});

describe("background eligibility and invalidation", () => {
  it("never visits unseen events or hidden/archived/deleted sources, and waits for active sources to settle", async () => {
    vi.useFakeTimers();
    const host = await load();
    await host.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "unseen" }), lastAssistantText: null });
    for (const fields of [{ visibility: "hidden" as const }, { archivedAt: 1 }, { deletedAt: 1 }]) {
      host.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: INPUT.threadId, ...fields }));
      await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    }
    let source = makeThreadResponse({ id: INPUT.threadId, status: "active", runtime: { displayStatus: "active" } });
    host.inspection.sdk.stub("threads.get", async () => source);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ running: true });
    await vi.advanceTimersByTimeAsync(360_000);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    source = makeThreadResponse({ id: INPUT.threadId, status: "idle", runtime: { displayStatus: "idle" } });
    await host.behavior.emitThreadEvent("thread.idle", { thread: source, lastAssistantText: null });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("resets on real history/execution activity but not same-sequence events or polling", async () => {
    vi.useFakeTimers();
    const host = await load();
    let seq = 1;
    host.inspection.sdk.stub("threads.timeline", async () => ({ rows: [{ id: "m", kind: "conversation", role: "user", text: "work", sourceSeqStart: 1 }], maxSeq: seq, timelinePage: { hasOlderRows: false, olderCursor: null } }));
    const source = makeThreadResponse({ id: INPUT.threadId, status: "idle", runtime: { displayStatus: "idle" } });
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(100_000);
    seq = 2;
    await host.behavior.emitThreadEvent("experimental_thread.events", { thread: source, sequence: seq });
    await vi.advanceTimersByTimeAsync(100_000);
    await host.behavior.emitThreadEvent("experimental_thread.events", { thread: source, sequence: seq });
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(79_999);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("skips disabled/missing models without an attempted paid failure and rearms on settings/model saves", async () => {
    vi.useFakeTimers();
    const host = await load(undefined, false, { backgroundEnabled: false });
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await host.behavior.setSettings({ backgroundEnabled: true });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await host.behavior.callRpc("setModel", MODEL);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
    await host.behavior.setSettings({ maxHistoryChars: 10_000 });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: true });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(2);
    await host.behavior.callRpc("setModel", { ...MODEL, model: "another" });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(3);
  });
  it("attempts a failed paid version once across idle events/reload; force retries and modes cache separately", async () => {
    vi.useFakeTimers();
    const host = await load();
    host.inspection.sdk.stub("threads.output", async () => ({ output: "invalid" }));
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    await host.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: INPUT.threadId }), lastAssistantText: null });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
    const replacement = await host.lifecycle.reload(plugin); hosts.push(replacement);
    await expect(replacement.harness.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: false });
    expect(args(replacement.harness, "threads.spawn")).toHaveLength(0);
    const restored = replacement.harness;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(restored, "threads.spawn")).toHaveLength(0);
    restored.inspection.sdk.stub("threads.output", async () => ({ output: "<overview>Ready to resume</overview><recap>## Context\nFixed</recap>" }));
    await expect(restored.behavior.callRpc("recap", { ...INPUT, force: true })).resolves.toMatchObject({ ok: true, preview: "Ready to resume", fromCache: false });
    await expect(restored.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ fromCache: true });
    await restored.behavior.callRpc("recap", { ...INPUT, short: false });
    await expect(restored.behavior.callRpc("recap", { ...INPUT, short: false })).resolves.toMatchObject({ fromCache: true });
    expect(args(restored, "threads.spawn")).toHaveLength(2);
  });
});

describe("automatic job ownership", () => {
  it("joins a matching brief job; reader cancellation cannot stop it and detailed callers stay busy", async () => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    host.inspection.sdk.stub("threads.wait", async () => wait.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
    const reading = host.behavior.callRpc("recap", INPUT);
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ code: "busy" });
    await expect(host.behavior.callRpc("recap", { ...INPUT, requestId: "other", short: false })).resolves.toMatchObject({ code: "busy" });
    await host.behavior.callRpc("cancel", { requestId: INPUT.requestId, threadId: INPUT.threadId });
    await expect(reading).resolves.toMatchObject({ code: "cancelled" });
    expect(args(host, "threads.stop")).toHaveLength(0);
    const joined = host.behavior.callRpc("recap", { ...INPUT, requestId: "reader-2" });
    await vi.advanceTimersByTimeAsync(0);
    wait.resolve({ matched: true });
    await expect(joined).resolves.toMatchObject({ ok: true, fromCache: false });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: { ok: true }, stale: false });
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("runs only one automatic job globally, without locking status/cache storage over model work", async () => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    host.inspection.sdk.stub("threads.wait", async () => wait.promise);
    await host.behavior.callRpc("getRecap", { threadId: "a" });
    await host.behavior.callRpc("getRecap", { threadId: "b" });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
    await expect(host.behavior.callRpc("getRecap", { threadId: "b" })).resolves.toMatchObject({ cached: null });
    wait.resolve({ matched: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(args(host, "threads.spawn")).toHaveLength(2);
  });
  it("keeps an in-flight earlier history snapshot stale, then generates the new version after its own deadline", async () => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    host.inspection.sdk.stub("threads.wait", async () => wait.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    host.inspection.sdk.stub("threads.timeline", async () => ({ rows: [{ id: "m2", kind: "conversation", role: "user", text: "new work", sourceSeqStart: 2 }], maxSeq: 2, timelinePage: { hasOlderRows: false, olderCursor: null } }));
    await host.behavior.emitThreadEvent("experimental_thread.events", { thread: makeThreadResponse({ id: INPUT.threadId }), sequence: 2 });
    wait.resolve({ matched: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: true, sourceMaxSeq: 2, cached: { coverage: { sourceMaxSeq: 1 } } });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(2);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ stale: false, cached: { coverage: { sourceMaxSeq: 2 } } });
  });
  it.each(["thread.active", "thread.archived", "thread.deleted"] as const)("aborts automatic work on %s without saving a late output", async (event) => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    let signal: AbortSignal | undefined;
    host.inspection.sdk.stub("threads.wait", async (input: { signal?: AbortSignal }) => { signal = input.signal; return wait.promise; });
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    const source = makeThreadResponse({ id: INPUT.threadId, ...(event === "thread.active" ? { status: "active", runtime: { displayStatus: "active" } } : event === "thread.archived" ? { archivedAt: 1 } : { deletedAt: 1 }) });
    host.inspection.sdk.stub("threads.get", async () => source);
    await host.behavior.emitThreadEvent(event, { thread: source });
    expect(signal?.aborted).toBe(true);
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "recap-worker" });
    wait.resolve({ matched: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: null });
  });
  it("does not resurrect a source when a status probe resolves after deletion", async () => {
    vi.useFakeTimers();
    const host = await load();
    const get = deferred<ReturnType<typeof makeThreadResponse>>();
    const started = deferred<void>();
    host.inspection.sdk.stub("threads.get", async () => { started.resolve(); return get.promise; });
    const status = host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await started.promise;
    await host.behavior.emitThreadEvent("thread.deleted", { thread: makeThreadResponse({ id: INPUT.threadId, deletedAt: 1 }) });
    get.resolve(makeThreadResponse({ id: INPUT.threadId }));
    await expect(status).resolves.toMatchObject({ cached: null, sourceMaxSeq: null });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(0);
  });
  it("cleans a late automatic spawn after eviction and never persists its result", async () => {
    vi.useFakeTimers();
    const host = await load();
    const spawn = deferred<ReturnType<typeof makeThreadResponse>>();
    host.inspection.sdk.stub("threads.spawn", async () => spawn.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    for (let i = 0; i < 100; i++) await host.behavior.callRpc("getRecap", { threadId: `other-${i}` });
    spawn.resolve(makeThreadResponse({ id: "late-evicted", visibility: "hidden" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "late-evicted" });
    expect(args(host, "threads.wait")).toHaveLength(0);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: null });
  });
  it("disposes timers and cleans a spawn arriving after the bounded disposal wait without touching stale storage", async () => {
    vi.useFakeTimers();
    const host = await load();
    const spawn = deferred<ReturnType<typeof makeThreadResponse>>();
    host.inspection.sdk.stub("threads.spawn", async () => spawn.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    const disposing = host.lifecycle.dispose();
    await vi.advanceTimersByTimeAsync(10_000);
    await disposing;
    spawn.resolve(makeThreadResponse({ id: "late-disposed", visibility: "hidden" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "late-disposed" });
    const before = args(host, "threads.spawn").length;
    await vi.advanceTimersByTimeAsync(360_000);
    expect(args(host, "threads.spawn")).toHaveLength(before);
  });
  it("does not let an older asynchronous active event overwrite a newer idle transition", async () => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    host.inspection.sdk.stub("threads.wait", async () => wait.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    const stopping = deferred<unknown>();
    const entered = deferred<void>();
    host.inspection.sdk.stub("threads.stop", async () => { entered.resolve(); return stopping.promise; });
    const activeEvent = host.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: INPUT.threadId, status: "active", runtime: { displayStatus: "active" } }) });
    await entered.promise;
    await host.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: INPUT.threadId }), lastAssistantText: null });
    stopping.resolve({ ok: true }); await activeEvent;
    wait.resolve({ matched: true }); await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(2);
  });
  it("bounds automatic generation by the configured timeout and persists its failure marker", async () => {
    vi.useFakeTimers();
    const host = await load(undefined, true, { timeoutSec: 10 });
    host.inspection.sdk.stub("threads.wait", async ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "recap-worker" });
    await host.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: INPUT.threadId }), lastAssistantText: null });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("clears pending background clocks and aborts known automatic workers on disposal", async () => {
    vi.useFakeTimers();
    const host = await load();
    host.inspection.sdk.stub("threads.wait", async ({ signal }: { signal: AbortSignal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true })));
    await host.behavior.callRpc("getRecap", { threadId: "a" });
    await host.behavior.callRpc("getRecap", { threadId: "b" });
    await vi.advanceTimersByTimeAsync(180_000);
    await host.lifecycle.dispose();
    expect(args(host, "threads.stop")).toContainEqual({ threadId: "recap-worker" });
    await vi.advanceTimersByTimeAsync(360_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
});


describe("background review regressions", () => {
  it("ignores an older active probe completing after a newer idle probe", async () => {
    vi.useFakeTimers();
    const host = await load();
    let source = makeThreadResponse({ id: INPUT.threadId, status: "active", runtime: { displayStatus: "active" } });
    host.inspection.sdk.stub("threads.get", async () => source);
    const page = (seq: number) => ({ rows: [{ id: "m", kind: "conversation", role: "user", text: "work", sourceSeqStart: 1 }], maxSeq: seq, timelinePage: { hasOlderRows: false, olderCursor: null } });
    const olderPage = deferred<ReturnType<typeof page>>();
    const entered = deferred<void>();
    let first = true;
    host.inspection.sdk.stub("threads.timeline", async () => {
      if (first) { first = false; entered.resolve(); return olderPage.promise; }
      return page(2);
    });
    const older = host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await entered.promise;
    source = makeThreadResponse({ id: INPUT.threadId, status: "idle", runtime: { displayStatus: "idle" } });
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    olderPage.resolve(page(1));
    await older;
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("cancels an idle-activity job and waits a new complete inactivity window before retrying", async () => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    let signal: AbortSignal | undefined;
    host.inspection.sdk.stub("threads.wait", async (input: { signal?: AbortSignal }) => { signal = input.signal; return wait.promise; });
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    try {
      await vi.advanceTimersByTimeAsync(1_000);
      await host.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: INPUT.threadId }), lastAssistantText: null });
      expect(signal?.aborted).toBe(true);
      wait.resolve({ matched: true });
      await vi.advanceTimersByTimeAsync(0);
      await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: null });
      await vi.advanceTimersByTimeAsync(179_999);
      expect(args(host, "threads.spawn")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(args(host, "threads.spawn")).toHaveLength(2);
    } finally { wait.resolve({ matched: true }); await vi.advanceTimersByTimeAsync(0); }
  });
  it("retries a settings-cancelled job after re-enabling background with unchanged generation settings", async () => {
    vi.useFakeTimers();
    const host = await load();
    const wait = deferred<unknown>();
    host.inspection.sdk.stub("threads.wait", async () => wait.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    await host.behavior.setSettings({ backgroundEnabled: false });
    wait.resolve({ matched: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: null });
    await host.behavior.setSettings({ backgroundEnabled: true });
    await vi.advanceTimersByTimeAsync(179_999);
    expect(args(host, "threads.spawn")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(args(host, "threads.spawn")).toHaveLength(2);
  });
  it("does not erase a genuine failure when settings change during worker cleanup", async () => {
    vi.useFakeTimers();
    const host = await load();
    const archived = deferred<unknown>();
    host.inspection.sdk.stub("threads.output", async () => ({ output: "invalid" }));
    host.inspection.sdk.stub("threads.archive", async () => archived.promise);
    await host.behavior.callRpc("getRecap", { threadId: INPUT.threadId });
    await vi.advanceTimersByTimeAsync(180_000);
    await host.behavior.setSettings({ backgroundEnabled: false });
    await host.behavior.setSettings({ backgroundEnabled: true });
    archived.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("preserves manual Recap and cached Details for an archived normal thread without background work", async () => {
    vi.useFakeTimers();
    const host = await load();
    host.inspection.sdk.stub("threads.get", async () => makeThreadResponse({ id: INPUT.threadId, archivedAt: 1 }));
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: null });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(0);
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ ok: true, coverage: { sourceMaxSeq: 1 } });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: { ok: true }, stale: false, sourceMaxSeq: 1 });
    await expect(host.behavior.callRpc("recap", INPUT)).resolves.toMatchObject({ fromCache: true });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
  it("does not invent a history change when the current source is temporarily unavailable", async () => {
    const host = await load();
    await host.behavior.callRpc("recap", INPUT);
    host.inspection.sdk.stub("threads.get", async () => { throw new Error("temporarily offline"); });
    await expect(host.behavior.callRpc("getRecap", { threadId: INPUT.threadId })).resolves.toMatchObject({ cached: { ok: true }, stale: false, sourceMaxSeq: null });
    expect(args(host, "threads.spawn")).toHaveLength(1);
  });
});
