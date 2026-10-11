// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";

const app = await loadPluginApp(() => import("./app"));
const badge = app.threadHeaderActions[0]!;
const customization = app.composerCustomizations[0]!;
const banner = customization.banners![0]!;

const NOW = 1_800_000_000_000;
const MIN = 60_000;

type SdkFakes = NonNullable<NonNullable<Parameters<typeof renderSlot>[2]>["sdk"]>;
type ThreadChanged = { changes: string[]; metadata?: { eventTypes?: string[] } };

interface FakeThread {
  providerId?: string;
  /** Usage, context, compaction and clear events, newest first. */
  events: unknown[];
  rateLimits?: unknown[];
  /** The model of the latest turn request. */
  model?: string;
  /** Replaces `threads.get`, to hold or fail a load. */
  get?: () => Promise<unknown>;
}

function usage(createdAt: number, read: number, write: number, fresh: number) {
  return {
    type: "thread/tokenUsage/updated",
    createdAt,
    data: {
      tokenUsage: {
        last: {
          inputTokens: fresh,
          cachedInputTokens: read + write,
          cacheReadInputTokens: read,
          cacheWriteInputTokens: write,
        },
      },
    },
  };
}

function context(createdAt: number, usedTokens: number) {
  return { type: "thread/contextWindowUsage/updated", createdAt, data: { contextWindowUsage: { usedTokens } } };
}

/** A fake `useSdk()` backed by a mutable thread, plus a way to push `thread:changed` events. */
function fakeSdk(thread: FakeThread) {
  const listeners: Array<(event: ThreadChanged) => void> = [];
  const compact = vi.fn(async () => ({ ok: true }));
  // Like the server: matching types after `afterSeq`, newest first unless `order: "asc"`, cut at `limit`.
  const list = vi.fn(async (args: { types: string[]; limit?: string; order?: "asc" | "desc"; afterSeq?: string }) => {
    const requested = thread.model
      ? [{ type: "client/turn/requested", createdAt: 0, data: { execution: { model: thread.model } } }]
      : [];
    const rows = [...thread.events, ...(thread.rateLimits ?? []), ...requested] as Array<{ type: string }>;
    const matching = rows
      .map((row, index) => ({ seq: rows.length - index, ...row }))
      .filter((row) => args.types.includes(row.type))
      .filter((row) => args.afterSeq === undefined || row.seq > Number(args.afterSeq));
    if (args.order === "asc") matching.reverse();
    return args.limit === undefined ? matching : matching.slice(0, Number(args.limit));
  });
  const sdk = {
    threads: {
      get: () => thread.get?.() ?? Promise.resolve({ providerId: thread.providerId ?? "claude-code" }),
      events: { list },
      compact,
    },
    subscribe: (args: { event: string; callback: (event: ThreadChanged) => void }) => {
      if (args.event === "thread:changed") listeners.push(args.callback);
      return () => {};
    },
  } as unknown as SdkFakes;
  const push = (event: ThreadChanged) => act(() => listeners.forEach((listener) => listener(event)));
  return { sdk, compact, push, list };
}

function renderBadge(thread: FakeThread, settings: Record<string, string | number | boolean> = {}) {
  const fake = fakeSdk(thread);
  const slot = renderSlot(badge, { threadId: "t", projectId: "p", isCompactViewport: false }, { sdk: fake.sdk, settings });
  return { slot, ...fake };
}

function renderBanner(
  thread: FakeThread,
  options: { threadId?: string; isRunning?: boolean; settings?: Record<string, string | number | boolean> } = {},
) {
  const fake = fakeSdk(thread);
  const slot = renderSlot(banner, {}, {
    sdk: fake.sdk,
    settings: options.settings ?? {},
    composer: { scope: { kind: "thread", threadId: options.threadId ?? "t" }, isRunning: options.isRunning ?? false },
  });
  return { slot, ...fake };
}

/** Lets pending loads settle, for asserting that nothing rendered. */
async function settle(): Promise<void> {
  await act(() => new Promise((done) => setTimeout(done, 0)));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("CacheBadge", () => {
  it("shows the cache hit rate and the time left", async () => {
    const { slot } = renderBadge({ events: [usage(NOW - 79_000, 98_000, 1_000, 1_000)] });
    const button = await slot.findByRole("button", { name: /98% from cache, expires in 3:41/ });
    expect(slot.getByText("98% · 3:41")).toBeTruthy();
    expect(button.className).not.toContain("text-destructive");
  });

  it("renders nothing without usage", async () => {
    const { slot } = renderBadge({ events: [context(NOW, 5_000)] });
    await settle();
    expect(slot.container.textContent).toBe("");
  });

  it("says expired in red once the lifetime runs out", async () => {
    const { slot } = renderBadge({ events: [usage(NOW - 6 * MIN, 98_000, 1_000, 1_000)] });
    expect(await slot.findByText("98% · expired")).toBeTruthy();
    expect(slot.getByRole("button", { name: /expired/ }).className).toContain("text-destructive");
  });

  it("uses an hour for a Claude subscription", async () => {
    const { slot } = renderBadge({
      events: [usage(NOW - 10 * MIN, 50, 0, 50)],
      rateLimits: [
        { type: "provider/rateLimits/updated", createdAt: NOW, data: { rateLimits: { kind: "subscription-window", status: "allowed" } } },
      ],
    });
    expect(await slot.findByText("50% · 50:00")).toBeTruthy();
  });

  it("reloads when usage events arrive and ignores unrelated events", async () => {
    const thread: FakeThread = { events: [usage(NOW - 2 * MIN, 50, 0, 50)] };
    const { slot, push } = renderBadge(thread);
    expect(await slot.findByText("50% · 3:00")).toBeTruthy();

    thread.events = [usage(NOW, 90, 0, 10)];
    await push({ changes: ["events-appended"], metadata: { eventTypes: ["item/agentMessage/delta"] } });
    await settle();
    expect(slot.getByText("50% · 3:00")).toBeTruthy();

    await push({ changes: ["events-appended"], metadata: { eventTypes: ["thread/tokenUsage/updated"] } });
    expect(await slot.findByText("90% · 5:00")).toBeTruthy();
  });

  it("keeps the latest usage through a long turn of context reports", async () => {
    const reports = Array.from({ length: 60 }, (_, index) => context(NOW - index, 120_000));
    const { slot } = renderBadge({ events: [...reports, usage(NOW - MIN, 98_000, 1_000, 1_000)] });
    expect(await slot.findByText("98% · 5:00")).toBeTruthy();
  });

  it("opens details with the breakdown and the lifetime source", async () => {
    const { slot } = renderBadge({ events: [usage(NOW - 79_000, 148_000, 2_400, 300)] }, { claudeCodeTtl: "5m" });
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("Expires in 3:41")).toBeTruthy();
    expect(slot.getByText("Last turn · 151k prompt")).toBeTruthy();
    expect(slot.getByText("read 148k")).toBeTruthy();
    expect(slot.getByText("written 2.4k")).toBeTruthy();
    expect(slot.getByText("new 300")).toBeTruthy();
    expect(slot.getByText(/Set in the plugin settings/)).toBeTruthy();
    expect(slot.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("prices a rewrite against a warm read for a known model", async () => {
    const { slot } = renderBadge({ events: [usage(NOW - 79_000, 148_000, 2_400, 300)], model: "claude-opus-5-5" });
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("If it expires, the next message costs ≈ $0.75 instead of ≈ $0.03 (API prices).")).toBeTruthy();
  });

  it("shows no prices for a model without a known price", async () => {
    const { slot } = renderBadge({ events: [usage(NOW - 79_000, 148_000, 2_400, 300)], model: "gpt-5.3-codex" });
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("Expires in 3:41")).toBeTruthy();
    expect(slot.queryByText(/API prices/)).toBeNull();
  });

  it("flags a turn that sent the earlier context again and counts the rewrites", async () => {
    const thread: FakeThread = {
      model: "claude-opus-5-5",
      events: [
        context(NOW - MIN, 105_000),
        usage(NOW - MIN - 1, 395_000, 105_000, 5),
        context(NOW - 10 * MIN, 100_000),
        usage(NOW - 11 * MIN, 295_000, 5_000, 5),
      ],
    };
    const { slot } = renderBadge(thread);
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("This turn sent 100k tokens of earlier context again.")).toBeTruthy();
    expect(slot.getByText("1 cache rewrite in the last 20 turns: 100k tokens, ≈ $0.50.")).toBeTruthy();
  });

  it("says when the recent turns read the cache every time", async () => {
    const thread: FakeThread = {
      events: [
        context(NOW - MIN, 110_000),
        usage(NOW - MIN - 1, 595_000, 5_000, 5),
        context(NOW - 10 * MIN, 105_000),
        usage(NOW - 11 * MIN, 396_000, 5_000, 5),
      ],
    };
    const { slot } = renderBadge(thread);
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("No cache rewrites in the last 20 turns.")).toBeTruthy();
    expect(slot.queryByText(/of earlier context again/)).toBeNull();
  });

  it("skips an empty context report after a turn when looking for its size", async () => {
    const thread: FakeThread = {
      events: [
        context(NOW - MIN, 105_000),
        usage(NOW - MIN - 1, 0, 105_000, 5),
        context(NOW - 10 * MIN, 100_000),
        context(NOW - 10 * MIN - 1, 0),
        usage(NOW - 11 * MIN, 95_000, 5_000, 5),
      ],
    };
    const { slot } = renderBadge(thread);
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("This turn sent 100k tokens of earlier context again.")).toBeTruthy();
  });

  it("judges all of the last 20 requests", async () => {
    // Request 2 of 21 rewrote the cache; it needs request 1 to be judged.
    const warm = Array.from({ length: 19 }, (_, index) => usage(NOW - MIN - index, 101_005, 1_000, 5));
    const thread: FakeThread = {
      providerId: "pi",
      events: [...warm, usage(NOW - 30 * MIN, 0, 101_000, 5), usage(NOW - 31 * MIN, 0, 100_000, 5)],
    };
    const { slot } = renderBadge(thread);
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText(/^1 cache rewrite in the last 20 requests: 100k tokens/)).toBeTruthy();
  });

  it("prices a Haiku 5.5 rewrite at the tier of the whole prompt", async () => {
    const thread: FakeThread = {
      model: "claude-haiku-5-5",
      events: [
        context(NOW - MIN, 120_000),
        usage(NOW - MIN - 1, 40_000, 80_000, 5),
        context(NOW - 10 * MIN, 120_000),
        usage(NOW - 11 * MIN, 115_000, 5_000, 5),
      ],
    };
    const { slot } = renderBadge(thread);
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("1 cache rewrite in the last 20 turns: 80k tokens, ≈ $0.05.")).toBeTruthy();
  });

  it("reprices when a turn asks for another model", async () => {
    const thread: FakeThread = { events: [usage(NOW - 79_000, 148_000, 2_400, 300)], model: "claude-opus-5-5" };
    const { slot, push } = renderBadge(thread);
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText(/costs ≈ \$0\.75 instead/)).toBeTruthy();
    thread.model = "claude-sonnet-5-5";
    await push({ changes: ["events-appended"], metadata: { eventTypes: ["client/turn/requested"] } });
    expect(await slot.findByText(/costs ≈ \$0\.38 instead/)).toBeTruthy();
  });

  it("looks up the context after each turn once", async () => {
    const thread: FakeThread = {
      events: [context(NOW - MIN, 105_000), usage(NOW - MIN - 1, 396_000, 104_000, 5), context(NOW - 10 * MIN, 100_000), usage(NOW - 11 * MIN, 295_000, 5_000, 5)],
    };
    const { slot, push, list } = renderBadge(thread);
    expect(await slot.findByRole("button", { name: /from cache/ })).toBeTruthy();
    const lookups = () => list.mock.calls.filter(([args]) => args.afterSeq !== undefined).length;
    const before = lookups();
    expect(before).toBeGreaterThan(0);
    await push({ changes: ["events-appended"], metadata: { eventTypes: ["thread/tokenUsage/updated"] } });
    await settle();
    expect(lookups()).toBe(before);
  });

  it("offers Compact in the details whenever the cache expired", async () => {
    const { slot, compact } = renderBadge({
      events: [context(NOW - 6 * MIN, 12_000), usage(NOW - 7 * MIN, 9_000, 500, 300)],
    });
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("The next message sends 12k tokens without the cache.")).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Compact" }));
    await waitFor(() => expect(compact).toHaveBeenCalledWith({ threadId: "t" }));
  });

  it("prices the next message once the cache expired", async () => {
    const { slot } = renderBadge({
      events: [context(NOW - 6 * MIN, 12_000), usage(NOW - 7 * MIN, 9_000, 500, 300)],
      model: "claude-opus-5-5",
    });
    fireEvent.click(await slot.findByRole("button", { name: /from cache/ }));
    expect(await slot.findByText("The next message sends 12k tokens without the cache, ≈ $0.06 at API prices.")).toBeTruthy();
  });
});

describe("CacheBanner", () => {
  it("mounts only on thread composers", () => {
    expect(customization.scopes).toEqual(["thread"]);
  });

  it("asks to reply while the cache is about to expire", async () => {
    const { slot } = renderBanner({ events: [usage(NOW - 4 * MIN - 18_000, 148_000, 2_400, 300)] });
    expect(await slot.findByText(/Prompt cache expires in 0:42/)).toBeTruthy();
    expect(slot.getByText(/sends 151k tokens without the cache\./)).toBeTruthy();
    expect(slot.getByRole("status").className).not.toContain("text-destructive");
    expect(slot.queryByRole("button", { name: "Compact" })).toBeNull();
  });

  it("offers Compact once the cache expired on a large context", async () => {
    const { slot, compact } = renderBanner({ events: [usage(NOW - 6 * MIN, 148_000, 2_400, 300)] });
    expect(await slot.findByText(/Prompt cache expired:/)).toBeTruthy();
    expect(slot.getByRole("status").className).toContain("text-destructive");
    fireEvent.click(slot.getByRole("button", { name: "Compact" }));
    await waitFor(() => expect(compact).toHaveBeenCalledWith({ threadId: "t" }));
  });

  it("adds the price of the next message for a known model", async () => {
    const expiring = renderBanner({ events: [usage(NOW - 4 * MIN - 18_000, 148_000, 2_400, 300)], model: "claude-opus-5-5" });
    expect(await expiring.slot.findByText(/sends 151k tokens without the cache \(≈ \$0\.75\)\./)).toBeTruthy();
    cleanup();
    const expired = renderBanner({ events: [usage(NOW - 6 * MIN, 148_000, 2_400, 300)], model: "claude-opus-5-5" });
    expect(await expired.slot.findByText(/expired: the next message sends 151k tokens without the cache \(≈ \$0\.75\)\./)).toBeTruthy();
  });

  it("stays hidden for a warm cache, a small context, a running thread, or the banner turned off", async () => {
    const warm = renderBanner({ events: [usage(NOW - MIN, 148_000, 2_400, 300)] });
    const small = renderBanner({ events: [usage(NOW - 6 * MIN, 9_000, 500, 300)] });
    const running = renderBanner({ events: [usage(NOW - 6 * MIN, 148_000, 2_400, 300)] }, { isRunning: true });
    const off = renderBanner({ events: [usage(NOW - 6 * MIN, 148_000, 2_400, 300)] }, { settings: { banner: false } });
    await settle();
    for (const { slot } of [warm, small, running, off]) expect(slot.container.textContent).toBe("");
  });

  // Dismissals are shared per thread, so each of these tests uses its own thread.
  it("stays dismissed until the cache is used again", async () => {
    const thread: FakeThread = { events: [usage(NOW - 6 * MIN, 148_000, 2_400, 300)] };
    const { slot, push } = renderBanner(thread, { threadId: "t-again" });
    fireEvent.click(await slot.findByRole("button", { name: "Dismiss" }));
    expect(slot.queryByText(/Prompt cache expired:/)).toBeNull();

    thread.events = [usage(NOW - 5 * MIN - 1, 148_000, 2_400, 300)];
    await push({ changes: ["events-appended"], metadata: { eventTypes: ["thread/tokenUsage/updated"] } });
    expect(await slot.findByText(/Prompt cache expired:/)).toBeTruthy();
  });

  it("hides every banner of the thread on dismiss", async () => {
    const thread: FakeThread = { events: [usage(NOW - 6 * MIN, 148_000, 2_400, 300)] };
    const page = within(renderBanner(thread, { threadId: "t-twice" }).slot.container);
    const chat = within(renderBanner(thread, { threadId: "t-twice" }).slot.container);
    expect(await chat.findByText(/Prompt cache expired:/)).toBeTruthy();
    fireEvent.click(await page.findByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(chat.queryByText(/Prompt cache expired:/)).toBeNull());
  });
});

describe("reloading", () => {
  it("runs a reload queued behind one that failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail: (error: Error) => void = () => {};
    let loads = 0;
    const thread: FakeThread = {
      events: [usage(NOW - MIN, 98_000, 1_000, 1_000)],
      get: () => (++loads === 1 ? new Promise((_, reject) => (fail = reject)) : Promise.resolve({ providerId: "claude-code" })),
    };
    const { slot, push } = renderBadge(thread);
    await push({ changes: ["events-appended"], metadata: { eventTypes: ["thread/tokenUsage/updated"] } });
    await act(async () => fail(new Error("offline")));
    expect(await slot.findByText("98% · 4:00")).toBeTruthy();
  });
});
