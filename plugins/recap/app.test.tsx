// @vitest-environment jsdom

import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { act, cleanup, fireEvent, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelection, RecapResult, RecapState } from "./contract";

const app = await loadPluginApp(() => import("./app"));
const header = app.threadHeaderActions[0];
const settings = app.settingsSections[0];
const props = (threadId = "thread-a") => ({ threadId, projectId: "project-a", isCompactViewport: false });
const success: RecapResult = {
  ok: true,
  text: "## Next steps\nShip the tests.",
  coverage: { totalEntries: 10, includedEntries: 10, omittedEntries: 0, shortenedEntries: 0, hasOlder: false, sourceMaxSeq: 12 },
};
function pendingRecap() {
  const resolvers: Array<(value: RecapResult) => void> = [];
  return { recap: () => new Promise<RecapResult>((resolve) => resolvers.push(resolve)), resolvers };
}

const emptyState: RecapState = { cached: null, stale: false, running: false, backgroundEnabled: true };
const savedState: RecapState = { ...emptyState, cached: { ...success, preview: "Tests are ready to ship.", generatedAt: 1_791_590_400_000, fromCache: true } };
const modelCalls = (slot: ReturnType<typeof renderSlot>) => slot.inspection.rpcCalls.filter((call) => call.method !== "getRecap");
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
});

describe("Recap header action", () => {
  it("waits for the initial saved-state read before deciding to generate", async () => {
    let resolveStatus!: (state: RecapState) => void;
    const getRecap = () => new Promise<RecapState>((resolve) => { resolveStatus = resolve; });
    const recap = vi.fn(() => success);
    const slot = renderSlot(header, props("slow-initial-cache"), { rpc: { getRecap, recap } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    expect(modelCalls(slot)).toEqual([]);
    await act(async () => { resolveStatus(savedState); });
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
    expect(recap).not.toHaveBeenCalled();
  });
  it("does not generate if the dialog closes before its initial saved-state read completes", async () => {
    let resolveStatus!: (state: RecapState) => void;
    const getRecap = () => new Promise<RecapState>((resolve) => { resolveStatus = resolve; });
    const recap = vi.fn(() => success);
    const slot = renderSlot(header, props("closed-initial-cache"), { rpc: { getRecap, recap } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    fireEvent.keyDown(slot.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await act(async () => { resolveStatus(emptyState); });
    expect(recap).not.toHaveBeenCalled();
    expect(slot.queryByRole("dialog")).toBeNull();
  });
  it("opens an already known saved recap immediately without starting a model", async () => {
    const getRecap = vi.fn(() => savedState);
    const slot = renderSlot(header, props("cached-header"), { rpc: { getRecap } });
    await act(async () => {});
    expect(getRecap).toHaveBeenCalledWith({ threadId: "cached-header", short: true });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
    expect(modelCalls(slot)).toEqual([]);
  });
  it("requests a recap once only after opening, for the exact header thread, without touching the composer", async () => {
    expect(header.title).toBe("Recap");
    expect(app.composerCustomizations).toMatchObject([{ id: "recap", scopes: ["thread"], banners: [{ id: "summary", chrome: "bare" }] }]);
    const slot = renderSlot(header, props(), {
      composer: { text: "Untouched draft", scope: { kind: "thread", threadId: "different-composer-thread" } },
      rpc: { getRecap: () => emptyState, recap: () => success },
    });
    expect(modelCalls(slot)).toEqual([]);
    const trigger = slot.getByRole("button", { name: "Recap" });
    expect(trigger.className).toContain("h-7");
    fireEvent.click(trigger);
    expect(slot.getByRole("dialog")).toBeTruthy();
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
    expect(slot.inspection.rpcCalls).toContainEqual({ method: "getRecap", input: { threadId: "thread-a", short: true } });
    expect(modelCalls(slot)).toEqual([
      { method: "recap", input: { requestId: expect.any(String), threadId: "thread-a", short: true, force: false } },
    ]);
    expect(slot.getByRole("checkbox", { name: "Detailed recap" }).getAttribute("aria-checked")).toBe("false");
    expect(slot.inspection.composer.text).toBe("Untouched draft");
    expect(slot.inspection.composer.inputLockCalls).toEqual([]);
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.sdkCalls).toEqual([]);
  });
  it("starts one request per click under React StrictMode", async () => {
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: () => success, cancel: () => ({ cancelled: true }) } });
    const Header = header.component;
    slot.lifecycle.rerender(<StrictMode><Header {...props()} /></StrictMode>);
    expect(modelCalls(slot)).toEqual([]);
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "recap")).toHaveLength(1);
  });


  it("keeps a 28px accessible action in compact headers", () => {
    const slot = renderSlot(header, { ...props(), isCompactViewport: true }, { rpc: { getRecap: () => emptyState } });
    const trigger = slot.getByRole("button", { name: "Recap" });
    expect(trigger.className).toContain("h-7");
    expect(trigger.className).toContain("w-7");
    expect(modelCalls(slot)).toEqual([]);
  });

  it.each([
    { omittedEntries: 2 },
    { shortenedEntries: 3 },
    { hasOlder: true },
  ])("warns about partial coverage: %j", async (coverage) => {
    const slot = renderSlot(header, props(), {
      rpc: { getRecap: () => emptyState, recap: () => ({ ...success, coverage: { ...success.coverage, ...coverage } }) },
    });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByRole("note").textContent).toContain("Partial coverage"));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
  });
  it("opts into detailed mode only on Regenerate, and copies the Markdown source", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: () => success } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown")).toBeTruthy());
    expect(slot.queryByRole("note")).toBeNull();
    fireEvent.click(slot.getByRole("checkbox", { name: "Detailed recap" }));
    expect(modelCalls(slot)).toHaveLength(1);
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(modelCalls(slot)).toHaveLength(2));
    expect(modelCalls(slot)[1]?.input).toEqual({ requestId: expect.any(String), threadId: "thread-a", short: false, force: true });
    expect(modelCalls(slot)[1]?.input).not.toEqual(modelCalls(slot)[0]?.input);
    await waitFor(() => expect(slot.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", false));
    fireEvent.click(slot.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(success.text));
    await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Copied."));
  });
  it("does not reuse a detailed result as the default after the brief cache disappears", async () => {
    const detailed = { ...success, text: "Detailed-only result" };
    const recap = vi.fn().mockReturnValueOnce(success).mockReturnValueOnce(detailed).mockReturnValue(success);
    const slot = renderSlot(header, props("brief-reopen"), { rpc: { getRecap: () => emptyState, recap } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
    fireEvent.click(slot.getByRole("checkbox", { name: "Detailed recap" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(detailed.text));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(recap).toHaveBeenCalledTimes(3));
    expect(modelCalls(slot)[2].input).toMatchObject({ short: true });
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
  });


  it("reports clipboard errors inline without losing the recap", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("Permission denied")) },
    });
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: () => success } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown")).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe("Could not copy: Permission denied"));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
    expect(modelCalls(slot)).toHaveLength(1);
  });
  it.each(["contract", "transport"])("shows a %s error inline and retries manually", async (failure) => {
    const recap = vi.fn()
      .mockImplementationOnce(() => {
        if (failure === "transport") throw new Error("Server unavailable");
        return { ok: false, code: "no_model", message: "Choose a Recap model in settings" };
      })
      .mockReturnValue(success);
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe(
      failure === "transport" ? "Server unavailable" : "Choose a Recap model in settings",
    ));
    expect(recap).toHaveBeenCalledTimes(1);
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("shows progress and blocks duplicate requests while in flight", async () => {
    const pending = pendingRecap();
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: pending.recap, cancel: () => ({ cancelled: true }) } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(slot.getByRole("status").textContent).toContain("Generating recap"));
    const regenerate = slot.getByRole("button", { name: "Regenerate" });
    expect(regenerate).toHaveProperty("disabled", true);
    expect(slot.getByRole("button", { name: "Copy" })).toHaveProperty("disabled", true);
    fireEvent.click(regenerate);
    fireEvent.click(regenerate);
    expect(modelCalls(slot)).toHaveLength(1);
  });

  it("cancels with the exact request and thread, ignoring a late result after reopening", async () => {
    const pending = pendingRecap();
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: pending.recap, cancel: () => ({ cancelled: true }) } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(pending.resolvers).toHaveLength(1));
    const first = modelCalls(slot)[0].input;
    if (first === null || typeof first !== "object" || !("requestId" in first)) throw new Error("Missing recap request");
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(modelCalls(slot)[1]).toEqual({
      method: "cancel", input: { requestId: first.requestId, threadId: "thread-a" },
    });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(pending.resolvers).toHaveLength(2));
    await act(async () => { pending.resolvers[0]({ ...success, text: "Stale result" }); });
    expect(slot.queryByText("Stale result")).toBeNull();
    expect(slot.getByRole("status").textContent).toContain("Generating recap");
    await act(async () => { pending.resolvers[1](success); });
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text));
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "cancel")).toHaveLength(1);
  });

  it("cancels when the dialog is dismissed with Escape", async () => {
    const pending = pendingRecap();
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: pending.recap, cancel: () => ({ cancelled: true }) } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(pending.resolvers).toHaveLength(1));
    fireEvent.keyDown(slot.getByRole("dialog"), { key: "Escape", code: "Escape" });
    await waitFor(() => expect(slot.queryByRole("dialog")).toBeNull());
    expect(modelCalls(slot).map((call) => call.method)).toEqual(["recap", "cancel"]);
    await act(async () => { pending.resolvers[0](success); });
    expect(slot.queryByTestId("bb-markdown")).toBeNull();
  });

  it("cancels on unmount and ignores the late response", async () => {
    const pending = pendingRecap();
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: pending.recap, cancel: () => ({ cancelled: true }) } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(pending.resolvers).toHaveLength(1));
    slot.lifecycle.unmount();
    expect(modelCalls(slot).map((call) => call.method)).toEqual(["recap", "cancel"]);
    await act(async () => { pending.resolvers[0](success); });
    expect(slot.queryByTestId("bb-markdown")).toBeNull();
  });

  it("isolates threads: switching cancels and the new thread requires a fresh manual request", async () => {
    const pending = pendingRecap();
    const slot = renderSlot(header, props(), { rpc: { getRecap: () => emptyState, recap: pending.recap, cancel: () => ({ cancelled: true }) } });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(pending.resolvers).toHaveLength(1));
    const Header = header.component;
    slot.lifecycle.rerender(<Header {...props("thread-b")} />);
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(modelCalls(slot)[1]).toMatchObject({ method: "cancel", input: { threadId: "thread-a" } });
    await act(async () => { pending.resolvers[0]({ ...success, text: "Thread A result" }); });
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    await waitFor(() => expect(pending.resolvers).toHaveLength(2));
    expect(slot.queryByText("Thread A result")).toBeNull();
    expect(modelCalls(slot)[2]).toMatchObject({ method: "recap", input: { threadId: "thread-b", short: true } });
    await act(async () => { pending.resolvers[1]({ ...success, text: "Thread B result" }); });
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe("Thread B result"));
    slot.lifecycle.rerender(<Header {...props()} />);
    expect(slot.queryByRole("dialog")).toBeNull();
    expect(slot.queryByText("Thread B result")).toBeNull();
  });
});


const banner = app.composerCustomizations[0]?.banners?.[0];
function renderBanner(threadId: string, getRecap: () => RecapState | Promise<RecapState> = () => savedState, isRunning = false) {
  if (!banner) throw new Error("Missing banner");
  return renderSlot(banner, {}, { composer: { scope: { kind: "thread", threadId }, isRunning }, rpc: { getRecap } });
}

describe("Recap composer banner", () => {
  it("keeps a regenerated result when a later-started poll still returns the older cache", async () => {
    if (!banner) throw new Error("Missing banner");
    const next = { ...savedState.cached!, text: "Latest full summary", preview: "Latest overview", generatedAt: savedState.cached!.generatedAt! + 1 };
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "later-old-status" } },
      rpc: { getRecap: () => savedState, recap: () => next },
    });
    await act(async () => {});
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(next.text));
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(within(slot.getByRole("region", { name: "Thread recap" })).getByText(next.preview)).toBeTruthy();
  });
  it("removes a local regenerated banner after a later read confirms its cache was evicted", async () => {
    if (!banner) throw new Error("Missing banner");
    let state: RecapState = savedState;
    const next = { ...savedState.cached!, text: "Ephemeral latest summary", preview: "Ephemeral overview", generatedAt: savedState.cached!.generatedAt! + 1 };
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "evicted-local-result" } },
      rpc: { getRecap: () => state, recap: () => next },
    });
    await act(async () => {});
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(next.text));
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    state = { ...savedState, cached: null, stale: false };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(slot.queryByRole("region", { name: "Thread recap" })).toBeNull();
    expect(modelCalls(slot)).toHaveLength(1);
  });
  it("does not clear local authority when a pre-regeneration read returns an empty cache", async () => {
    if (!banner) throw new Error("Missing banner");
    let resolveStatus: (value: RecapState) => void = () => {};
    let delay = false;
    const next = { ...savedState.cached!, text: "Protected summary", preview: "Protected overview", generatedAt: savedState.cached!.generatedAt! + 1 };
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "old-empty-result" } },
      rpc: { getRecap: () => delay ? new Promise<RecapState>((resolve) => { resolveStatus = resolve; }) : savedState, recap: () => next },
    });
    await act(async () => {});
    delay = true;
    fireEvent(window, new Event("focus"));
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(next.text));
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    await act(async () => { resolveStatus({ ...savedState, cached: null }); });
    delay = false;
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(slot.getByText("Protected overview")).toBeTruthy();
  });
  it("labels an explicit detailed result outdated when the source revision advances", async () => {
    let state = { ...savedState, sourceMaxSeq: 12 };
    const detailedResult = { ...success, text: "Detailed summary", generatedAt: 1_791_590_400_001 };
    const slot = renderSlot(header, props("detailed-stale"), { rpc: { getRecap: () => state, recap: () => detailedResult } });
    await act(async () => {});
    fireEvent.click(slot.getByRole("button", { name: "Recap" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Detailed recap" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(detailedResult.text));
    state = { ...state, sourceMaxSeq: 13, stale: true };
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(slot.getByText("Outdated recap — the thread has changed since this summary.")).toBeTruthy();
  });
  it("deduplicates focus refreshes while a status request is still pending", async () => {
    const getRecap = vi.fn(() => new Promise<RecapState>(() => {}));
    const slot = renderBanner("pending-focus-status", getRecap);
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(getRecap).toHaveBeenCalledTimes(1);
    slot.lifecycle.unmount();
  });
  it("shows a newly regenerated brief result immediately and cannot regress to an older in-flight status read", async () => {
    if (!banner) throw new Error("Missing banner");
    let resolveStatus: (value: RecapState) => void = () => {};
    const getRecap = vi.fn().mockResolvedValueOnce(savedState).mockImplementation(() => new Promise<RecapState>((resolve) => { resolveStatus = resolve; }));
    const next = { ...savedState.cached!, text: "Fresh brief orientation", preview: "Fresh overview", generatedAt: savedState.cached!.generatedAt! + 1 };
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "banner-fresh-result" } },
      rpc: { getRecap, recap: () => next },
    });
    await slot.findByText("Tests are ready to ship.");
    fireEvent(window, new Event("focus"));
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(next.text));
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    expect(slot.getByText("Fresh overview")).toBeTruthy();
    await act(async () => { resolveStatus(savedState); });
    expect(slot.queryByText("Tests are ready to ship.")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(next.text);
    expect(modelCalls(slot)).toHaveLength(1);
  });
  it("caps dismissal memory at 100 thread keys", async () => {
    for (let i = 0; i <= 100; i++) {
      const slot = renderBanner(`banner-bounded-${i}`);
      await act(async () => {});
      fireEvent.click(slot.getByRole("button", { name: "Dismiss recap" }));
      slot.lifecycle.unmount();
    }
    const oldest = renderBanner("banner-bounded-0");
    await oldest.findByText("Tests are ready to ship.");
    oldest.lifecycle.unmount();
    const newest = renderBanner("banner-bounded-100");
    await act(async () => {});
    expect(newest.queryByRole("region", { name: "Thread recap" })).toBeNull();
  });

  it("labels stale saved content in the dialog too", async () => {
    const slot = renderBanner("banner-stale-dialog", () => ({ ...savedState, stale: true }));
    await slot.findByText("Tests are ready to ship.");
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    expect(within(slot.getByRole("dialog")).getByText(/Outdated recap/)).toBeTruthy();
    expect(modelCalls(slot)).toEqual([]);
  });
  it("marks unavailable source status as unverified, not outdated", async () => {
    const slot = renderBanner("banner-unverified", () => ({ ...savedState, stale: false, sourceMaxSeq: null }));
    await slot.findByText("Tests are ready to ship.");
    expect(slot.getByText("Unverified")).toBeTruthy();
    expect(slot.queryByText(/Outdated recap/)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    expect(within(slot.getByRole("dialog")).getByText("Unable to verify current thread state.")).toBeTruthy();
    expect(modelCalls(slot)).toEqual([]);
  });

  it("does not crash or invent an age for a timestamp outside the Date range", async () => {
    const slot = renderBanner("banner-invalid-date", () => ({ ...savedState, cached: { ...savedState.cached!, generatedAt: Number.MAX_SAFE_INTEGER } }));
    await slot.findByText("Tests are ready to ship.");
    expect(slot.container.querySelector("time")).toBeNull();
  });
  it("uses a bounded plain-text fallback for legacy results and omits unknown age", async () => {
    const slot = renderBanner("banner-legacy", () => ({ ...emptyState, cached: { ...success, text: "## Next steps\n**Ship** [the tests](https://example.com). " + "x".repeat(500) } }));
    const overview = await slot.findByText(/^Next steps Ship the tests\./);
    expect(overview.textContent?.length).toBeLessThanOrEqual(400);
    expect(overview.textContent).not.toContain("##");
    expect(overview.querySelector("a")).toBeNull();
    expect(slot.container.querySelector("time")).toBeNull();
    expect(slot.queryByText(/Updated/)).toBeNull();
  });

  it.each([
    { kind: "new-thread" as const, projectId: "project-a" },
    { kind: "queued-message" as const, threadId: "thread-a", queuedMessageId: "queued-a" },
  ])("does not register a visit or display a banner for %j", async (scope) => {
    if (!banner) throw new Error("Missing banner");
    const slot = renderSlot(banner, {}, { composer: { scope }, rpc: { getRecap: () => savedState } });
    await act(async () => {});
    expect(slot.inspection.rpcCalls).toEqual([]);
    expect(slot.queryByRole("region", { name: "Thread recap" })).toBeNull();
  });

  it("stays hidden while the main agent runs or no cache exists", async () => {
    const running = renderBanner("banner-running", () => savedState, true);
    await act(async () => {});
    expect(running.queryByRole("region", { name: "Thread recap" })).toBeNull();
    expect(running.inspection.rpcCalls).toEqual([{ method: "getRecap", input: { threadId: "banner-running", short: true } }]);
    running.lifecycle.unmount();
    const empty = renderBanner("banner-empty", () => ({ ...emptyState, running: true }));
    await act(async () => {});
    expect(empty.queryByRole("region", { name: "Thread recap" })).toBeNull();
    expect(modelCalls(empty)).toEqual([]);
  });

  it("immediately drops old route content and ignores late status responses from another thread", async () => {
    const resolvers: Array<(state: RecapState) => void> = [];
    const slot = renderBanner("banner-route-a", () => new Promise((resolve) => resolvers.push(resolve)));
    await act(async () => { resolvers[0](savedState); });
    expect(slot.getByText("Tests are ready to ship.")).toBeTruthy();
    fireEvent(window, new Event("focus"));
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "banner-route-b" });
    expect(slot.queryByText("Tests are ready to ship.")).toBeNull();
    await act(async () => { resolvers[1]({ ...savedState, cached: { ...savedState.cached!, preview: "Late old route" } }); });
    expect(slot.queryByText("Late old route")).toBeNull();
    await act(async () => { resolvers[2]({ ...savedState, cached: { ...savedState.cached!, preview: "Current route recap" } }); });
    expect(slot.getByText("Current route recap")).toBeTruthy();
    expect(slot.inspection.rpcCalls.map((call) => call.input)).toEqual([
      { threadId: "banner-route-a", short: true }, { threadId: "banner-route-a", short: true }, { threadId: "banner-route-b", short: true },
    ]);
  });

  it("polls every 20 seconds only while visible, refreshes on return/focus, and disposes timers and listeners", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const getRecap = vi.fn(() => savedState);
    const slot = renderBanner("banner-poll", getRecap);
    await act(async () => {});
    expect(getRecap).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(19_999); });
    expect(getRecap).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(getRecap).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    fireEvent(window, new Event("focus"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getRecap).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => {});
    expect(getRecap).toHaveBeenCalledTimes(3);
    fireEvent(window, new Event("focus"));
    await act(async () => {});
    expect(getRecap).toHaveBeenCalledTimes(4);
    slot.lifecycle.unmount();
    fireEvent(window, new Event("focus"));
    fireEvent(document, new Event("visibilitychange"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getRecap).toHaveBeenCalledTimes(4);
    expect(vi.getTimerCount()).toBe(0);
    expect(modelCalls(slot)).toEqual([]);
  });

  it("bounds pending polls and ignores late status results after unmount or StrictMode replay", async () => {
    if (!banner) throw new Error("Missing banner");
    vi.useFakeTimers();
    const resolvers: Array<(state: RecapState) => void> = [];
    const getRecap = vi.fn(() => new Promise<RecapState>((resolve) => resolvers.push(resolve)));
    const slot = renderBanner("banner-strict", getRecap);
    const Banner = banner.component;
    slot.lifecycle.rerender(<StrictMode><Banner /></StrictMode>);
    const count = getRecap.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getRecap).toHaveBeenCalledTimes(count);
    await act(async () => { resolvers.at(-1)!({ ...savedState, cached: { ...savedState.cached!, preview: "Current StrictMode status" } }); });
    expect(slot.getByText("Current StrictMode status")).toBeTruthy();
    await act(async () => { for (const resolve of resolvers.slice(0, -1)) resolve(savedState); });
    expect(slot.queryByText("Tests are ready to ship.")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    expect(getRecap).toHaveBeenCalledTimes(count + 1);
    slot.lifecycle.unmount();
    await act(async () => { resolvers.at(-1)!(savedState); });
    fireEvent(window, new Event("focus"));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(getRecap).toHaveBeenCalledTimes(count + 1);
    expect(vi.getTimerCount()).toBe(0);
    expect(modelCalls(slot)).toEqual([]);
  });
  it("regenerates saved Details with force and explicit detailed mode, keeps prior text, and handles non-owned cancellation", async () => {
    if (!banner) throw new Error("Missing banner");
    const pending = pendingRecap();
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "banner-regenerate" } },
      rpc: { getRecap: () => savedState, recap: pending.recap, cancel: () => ({ cancelled: false }) },
    });
    await slot.findByText("Tests are ready to ship.");
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Detailed recap" }));
    const regenerate = slot.getByRole("button", { name: "Regenerate" });
    fireEvent.click(regenerate);
    fireEvent.click(regenerate);
    expect(modelCalls(slot)).toEqual([{ method: "recap", input: { threadId: "banner-regenerate", requestId: expect.any(String), short: false, force: true } }]);
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
    expect(slot.getByRole("status").textContent).toContain("Generating");
    const first = modelCalls(slot)[0].input;
    if (first === null || typeof first !== "object" || !("requestId" in first)) throw new Error("Missing request");
    fireEvent.click(slot.getByRole("button", { name: "Cancel" }));
    expect(modelCalls(slot)[1]).toEqual({ method: "cancel", input: { threadId: "banner-regenerate", requestId: first.requestId } });
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    expect(slot.queryByRole("status")).toBeNull();
    expect(slot.getByRole("button", { name: "Regenerate" })).toHaveProperty("disabled", false);
    await act(async () => { pending.resolvers[0]({ ...success, text: "Late joined-job result" }); });
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
    expect(slot.queryByRole("alert")).toBeNull();
  });
  it("does not replace the brief banner with a detailed result and reopens in brief mode", async () => {
    const detailed = { ...success, text: "Detailed-only body", preview: "Detailed-only preview" };
    if (!banner) throw new Error("Missing banner");
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "detailed-does-not-replace-brief" } },
      rpc: { getRecap: () => savedState, recap: () => detailed },
    });
    await slot.findByText("Tests are ready to ship.");
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    fireEvent.click(slot.getByRole("checkbox", { name: "Detailed recap" }));
    fireEvent.click(slot.getByRole("button", { name: "Regenerate" }));
    await waitFor(() => expect(slot.getByTestId("bb-markdown").textContent).toBe(detailed.text));
    const region = within(slot.getByRole("region", { hidden: true }));
    expect(region.getByText("Tests are ready to ship.")).toBeTruthy();
    expect(region.queryByText(detailed.preview)).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Close" }));
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
    expect(slot.getByRole("checkbox", { name: "Detailed recap" }).getAttribute("aria-checked")).toBe("false");
    expect(modelCalls(slot)).toHaveLength(1);
  });
  it("dismisses only this result across route changes and remounts, and shows its next version", async () => {
    let state = savedState;
    const slot = renderBanner("banner-dismiss", () => state);
    await slot.findByText("Tests are ready to ship.");
    fireEvent.click(slot.getByRole("button", { name: "Dismiss recap" }));
    expect(slot.queryByRole("region", { name: "Thread recap" })).toBeNull();
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "banner-other" });
    await slot.findByText("Tests are ready to ship.");
    await slot.behavior.setComposerScope({ kind: "thread", threadId: "banner-dismiss" });
    await act(async () => {});
    expect(slot.queryByRole("region", { name: "Thread recap" })).toBeNull();
    slot.lifecycle.unmount();
    const remount = renderBanner("banner-dismiss", () => state);
    await act(async () => {});
    expect(remount.queryByRole("region", { name: "Thread recap" })).toBeNull();
    state = { ...savedState, cached: { ...savedState.cached!, generatedAt: savedState.cached!.generatedAt! + 1, preview: "New result is ready." } };
    fireEvent(window, new Event("focus"));
    await remount.findByText("New result is ready.");
    expect(modelCalls(remount)).toEqual([]);
  });
  it("shows a real cached overview, stale label and timestamp; Details reuses it without generation", async () => {
    const banner = app.composerCustomizations[0]?.banners?.[0];
    expect(banner).toBeTruthy();
    if (!banner) throw new Error("Missing banner");
    const slot = renderSlot(banner, {}, {
      composer: { scope: { kind: "thread", threadId: "banner-details" }, text: "Leave my draft alone" },
      rpc: { getRecap: () => ({ ...savedState, stale: true }) },
    });
    const overview = await slot.findByText("Tests are ready to ship.");
    expect(overview.className).toContain("line-clamp-2");
    expect(overview.className).toContain("break-words");
    expect(slot.getByText("Outdated recap")).toBeTruthy();
    expect(slot.container.querySelector("time")?.getAttribute("datetime")).toBe(new Date(savedState.cached!.generatedAt!).toISOString());
    expect(modelCalls(slot)).toEqual([]);
    expect(slot.getByRole("button", { name: "Dismiss recap" })).toBeTruthy();
    fireEvent.click(slot.getByRole("button", { name: "Details" }));
    expect(slot.getByTestId("bb-markdown").textContent).toBe(success.text);
    expect(modelCalls(slot)).toEqual([]);
    expect(slot.inspection.composer.text).toBe("Leave my draft alone");
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.inputLockCalls).toEqual([]);
  });
});

const selection: ModelSelection = { providerId: "provider-a", model: "model-a", reasoningLevel: "high", serviceTier: "fast" };

describe("Recap model settings", () => {
  it("loads its own selection using primary host routing and saves only on explicit confirmation", async () => {
    let resolveSave: (value: ModelSelection) => void = () => {};
    const slot = renderSlot(settings, {}, {
      rpc: {
        getModel: () => ({ selection, saved: false }),
        setModel: () => new Promise<ModelSelection>((resolve) => { resolveSave = resolve; }),
      },
    });
    expect(settings.title).toBe("Recap model");
    expect(slot.getByRole("status").textContent).toContain("Loading");
    await waitFor(() => expect(slot.getByLabelText("Model")).toHaveProperty("value", "model-a"));
    const picker = slot.getByTestId("bb-provider-model-picker");
    expect(picker.getAttribute("data-routing-kind")).toBe("primary");
    expect(slot.inspection.rpcCalls).toEqual([{ method: "getModel", input: null }]);
    fireEvent.change(slot.getByLabelText("Provider ID"), { target: { value: "provider-b" } });
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "model-b" } });
    fireEvent.change(slot.getByLabelText("Reasoning level"), { target: { value: "ultracode" } });
    fireEvent.change(slot.getByLabelText("Service tier"), { target: { value: "default" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply execution selection" }));
    expect(slot.inspection.rpcCalls).toHaveLength(1);
    const chosen: ModelSelection = { providerId: "provider-b", model: "model-b", reasoningLevel: "ultracode", serviceTier: "default" };
    const save = slot.getByRole("button", { name: "Use this model" });
    fireEvent.click(save);
    fireEvent.click(save);
    await waitFor(() => expect(slot.inspection.rpcCalls).toHaveLength(2));
    expect(slot.inspection.rpcCalls[1]).toEqual({ method: "setModel", input: chosen });
    expect(picker.getAttribute("data-disabled")).toBe("true");
    expect(slot.getByRole("button", { name: "Saving…" })).toHaveProperty("disabled", true);
    await act(async () => { resolveSave(chosen); });
    await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Model saved."));
    expect(picker.getAttribute("data-disabled")).toBe("false");
    expect(slot.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
  });


  it("does not invent a service tier when saving an unchanged selection", async () => {
    const { serviceTier: _tier, ...withoutTier } = selection;
    const slot = renderSlot(settings, {}, {
      rpc: { getModel: () => ({ selection: withoutTier, saved: false }), setModel: () => withoutTier },
    });
    await waitFor(() => expect(slot.getByRole("button", { name: "Use this model" })).toBeTruthy());
    fireEvent.click(slot.getByRole("button", { name: "Use this model" }));
    await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Model saved."));
    expect(slot.inspection.rpcCalls[1]).toEqual({ method: "setModel", input: withoutTier });
  });

  it("keeps a failed save's draft and allows an explicit retry without dropping optional fields", async () => {
    const setModel = vi.fn().mockRejectedValueOnce(new Error("Could not save")).mockResolvedValue(selection);
    const slot = renderSlot(settings, {}, { rpc: { getModel: () => ({ selection, saved: true }), setModel } });
    await waitFor(() => expect(slot.getByLabelText("Model")).toBeTruthy());
    expect(slot.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.change(slot.getByLabelText("Model"), { target: { value: "new-model" } });
    fireEvent.click(slot.getByRole("button", { name: "Apply execution selection" }));
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe("Could not save"));
    expect(slot.getByLabelText("Model")).toHaveProperty("value", "new-model");
    expect(slot.getByTestId("bb-provider-model-picker").getAttribute("data-disabled")).toBe("false");
    fireEvent.click(slot.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(slot.getByRole("status").textContent).toBe("Model saved."));
    expect(slot.inspection.rpcCalls.filter((call) => call.method === "setModel")).toEqual([
      { method: "setModel", input: { ...selection, model: "new-model" } },
      { method: "setModel", input: { ...selection, model: "new-model" } },
    ]);
  });

  it("reports load errors and supports Retry", async () => {
    const getModel = vi.fn().mockRejectedValueOnce(new Error("Load failed")).mockResolvedValue({ selection, saved: true });
    const slot = renderSlot(settings, {}, { rpc: { getModel } });
    await waitFor(() => expect(slot.getByRole("alert").textContent).toBe("Load failed"));
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(slot.getByLabelText("Model")).toHaveProperty("value", selection.model));
    expect(getModel).toHaveBeenCalledTimes(2);
    expect(slot.queryByRole("alert")).toBeNull();
  });

  it("shows the no-provider state and reloads after provider setup", async () => {
    const getModel = vi.fn().mockResolvedValueOnce({ selection: null, saved: false }).mockResolvedValue({ selection, saved: false });
    const slot = renderSlot(settings, {}, { rpc: { getModel } });
    await waitFor(() => expect(slot.getByText(/No provider is available/)).toBeTruthy());
    expect(slot.queryByTestId("bb-provider-model-picker")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(slot.getByRole("button", { name: "Use this model" })).toBeTruthy());
    expect(slot.inspection.rpcCalls.every((call) => call.method === "getModel")).toBe(true);
  });
});
