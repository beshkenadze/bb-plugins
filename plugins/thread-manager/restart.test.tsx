// @vitest-environment jsdom
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const app = await loadPluginApp(() => import("./app"));
const header = app.threadHeaderActions[0]!;
const props = { threadId: "header-thread", projectId: "project-a", isCompactViewport: false };
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("restart in the thread header", () => {
  it("releases only the header's runtime, verifies the stop, and keeps the draft", async () => {
    const stop = vi.fn(async () => ({ ok: true as const }));
    const get = vi.fn(async () => makeThreadResponse({ id: props.threadId }));
    const slot = renderSlot(header, props, {
      composer: { text: "Unsent draft", scope: { kind: "thread", threadId: "other-pane" } },
      sdk: { threads: { get, stop } },
    });
    expect(stop).not.toHaveBeenCalled();
    fireEvent.click(slot.getByRole("button", { name: "Restart agent" }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(slot.inspection.sdkCalls).toEqual([
      { method: "threads.get", args: [{ threadId: "header-thread" }] },
      { method: "threads.stop", args: [{ threadId: "header-thread" }] },
      { method: "threads.get", args: [{ threadId: "header-thread" }] },
    ]);
    expect(slot.inspection.composer.text).toBe("Unsent draft");
    expect(slot.inspection.composer.submits).toEqual([]);
    expect(slot.inspection.composer.inputLockCalls).toEqual([]);
  });

  it("runs once for rapid clicks under StrictMode and stays compact on phones", async () => {
    let resolveStop!: (value: { ok: true }) => void;
    const stop = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveStop = resolve; }));
    const compact = { ...props, isCompactViewport: true };
    const slot = renderSlot(header, compact, { sdk: { threads: { get: async () => makeThreadResponse(), stop } } });
    const Header = header.component;
    slot.lifecycle.rerender(<StrictMode><Header {...compact} /></StrictMode>);
    const button = slot.getByRole("button", { name: "Restart agent" });
    expect(button.className).toContain("size-7");
    fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(button.getAttribute("aria-busy")).toBe("true");
    resolveStop({ ok: true });
    await waitFor(() => expect(button.getAttribute("aria-busy")).toBe("false"));
  });

  it.each(["stop-error", "still-stopping", "offline", "archived"])("does not claim success for %s", async (failure) => {
    const get = vi.fn()
      .mockResolvedValueOnce(makeThreadResponse({
        ...(failure === "archived" ? { archivedAt: 1 } : {}),
        ...(failure === "offline" ? { runtime: { displayStatus: "waiting-for-host" } } : {}),
      }))
      .mockResolvedValue(makeThreadResponse({ status: "stopping" }));
    const stop = vi.fn(async () => {
      if (failure === "stop-error") throw new Error("Stop failed");
      return { ok: true as const };
    });
    const slot = renderSlot(header, props, { sdk: { threads: { get, stop } } });
    fireEvent.click(slot.getByRole("button", { name: "Restart agent" }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Could not restart agent", { description: expect.any(String) }));
    expect(toast.success).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(failure === "archived" || failure === "offline" ? 0 : 1);
  });

  it("does not show a stale completion after the header leaves the screen", async () => {
    let resolveStop!: (value: { ok: true }) => void;
    const stop = vi.fn(() => new Promise<{ ok: true }>((resolve) => { resolveStop = resolve; }));
    const slot = renderSlot(header, props, { sdk: { threads: { get: async () => makeThreadResponse(), stop } } });
    fireEvent.click(slot.getByRole("button", { name: "Restart agent" }));
    await waitFor(() => expect(stop).toHaveBeenCalled());
    slot.lifecycle.unmount();
    resolveStop({ ok: true });
    await waitFor(() => expect(slot.inspection.sdkCalls.filter((call) => call.method === "threads.get")).toHaveLength(2));
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
